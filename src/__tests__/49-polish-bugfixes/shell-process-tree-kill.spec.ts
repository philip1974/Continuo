// 流式 shell / 一次性 exec 终止时须杀整棵进程树:旧实现只杀直接子进程,`sh -c 'sleep 600 & wait'`
// 超时/abort 后后台 sleep 成孤儿继续跑并持有 stdout/stderr 管道 → close 迟迟不来,done / active 槽位
// (exec 的 Promise)挂住。真实子进程验证:后代把自己的 pid 写进临时文件,结束后断言其已不存在(ESRCH)。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../../electron/shared/plugin-shell-stream-channels';
import { registerPluginShellStreamHandlers } from '../../../electron/main/services/plugin-shell-stream.service';
import { execShell } from '../../../electron/main/services/shell.service';
import { StubIpcMain, makeFakeEvent, type StubIpcEvent } from '../sdk-contract/integration/make-stub-ipc';

// 进程组 / `sh` 语义仅 POSIX;Windows 走 taskkill /T(无 sh 可用,不在此验证)。
const HAS_SH = process.platform !== 'win32' && existsSync('/bin/sh');

interface StreamEvent {
  streamId: string;
  kind: 'stdout' | 'stderr' | 'exit';
  payload: unknown;
}

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function pidFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'tree-kill-'));
  dirs.push(d);
  return join(d, 'pid');
}

// 后台 sleep 写出自己的 pid 后 sh 等待它(sleep 继承 stdout/stderr 管道)。
function script(file: string): string[] {
  return ['-c', `sleep 600 & echo $! > '${file}'; echo ready; wait`];
}

async function waitUntil<T>(probe: () => T | undefined, what: string, ms = 4000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = probe();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function readPid(file: string): Promise<number> {
  const pid = await waitUntil(() => {
    if (!existsSync(file)) return undefined;
    const n = Number(readFileSync(file, 'utf-8').trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }, 'descendant pid');
  pids.push(pid);
  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function expectDead(pid: number): Promise<void> {
  await waitUntil(() => (isAlive(pid) ? undefined : true), `pid ${pid} to die`, 2000);
}

function events(event: StubIpcEvent): StreamEvent[] {
  return event.sender.send.mock.calls
    .filter((c) => c[0] === PLUGIN_SHELL_STREAM_CHANNELS.EVENT)
    .map((c) => c[1] as StreamEvent);
}

function harness(): { ipc: StubIpcMain; event: StubIpcEvent } {
  const ipc = new StubIpcMain();
  registerPluginShellStreamHandlers(ipc as never);
  return { ipc, event: makeFakeEvent({ id: 1, isDestroyed: () => false }) };
}

describe.skipIf(!HAS_SH)('49 · shell 终止杀整棵进程树(后代不成孤儿)', () => {
  it('stream ABORT → 后台后代被杀,exit 及时到达', async () => {
    const { ipc, event } = harness();
    const file = pidFile();
    await ipc.invokeWithEvent(event, PLUGIN_SHELL_STREAM_CHANNELS.START, 'abort-tree', '/bin/sh', script(file));
    const pid = await readPid(file);
    await ipc.invokeWithEvent(event, PLUGIN_SHELL_STREAM_CHANNELS.ABORT, 'abort-tree');
    await waitUntil(
      () => events(event).find((e) => e.streamId === 'abort-tree' && e.kind === 'exit'),
      'exit after abort',
    );
    await expectDead(pid);
  }, 10000);

  it('stream 超时 → 后台后代被杀,exit 及时到达', async () => {
    const { ipc, event } = harness();
    const file = pidFile();
    await ipc.invokeWithEvent(event, PLUGIN_SHELL_STREAM_CHANNELS.START, 'timeout-tree', '/bin/sh', script(file), {
      timeoutMs: 300,
    });
    const pid = await readPid(file);
    await waitUntil(
      () => events(event).find((e) => e.streamId === 'timeout-tree' && e.kind === 'exit'),
      'exit after timeout',
    );
    await expectDead(pid);
  }, 10000);

  // 后代自建进程组逃出整组信号、仍持 stdout/stderr 管道 → close 永不来;须强制 finalize 不无限等。
  const escaper = (file: string): string[] => [
    '-e',
    `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});require('fs').writeFileSync(${JSON.stringify(file)},String(c.pid));setInterval(()=>{},1000)`,
  ];

  it('stream 超时且后代逃出进程组持管道 → 仍强制结算 exit(不无限挂住)', async () => {
    const { ipc, event } = harness();
    const file = pidFile();
    await ipc.invokeWithEvent(event, PLUGIN_SHELL_STREAM_CHANNELS.START, 'escape-tree', process.execPath, escaper(file), {
      timeoutMs: 300,
    });
    await readPid(file);
    await waitUntil(
      () => events(event).find((e) => e.streamId === 'escape-tree' && e.kind === 'exit'),
      'forced exit',
      6000,
    );
  }, 10000);

  it('execShell 超时且后代逃出进程组持管道 → 仍强制 resolve', async () => {
    const file = pidFile();
    const pending = execShell({ cmd: process.execPath, args: escaper(file), timeoutMs: 300 });
    await readPid(file);
    const r = await pending;
    expect(r.timedOut).toBe(true);
  }, 10000);

  it('execShell 超时 → 后台后代被杀,Promise 及时 resolve(timedOut)', async () => {
    const file = pidFile();
    const started = Date.now();
    const pending = execShell({ cmd: '/bin/sh', args: script(file), timeoutMs: 300 });
    const pid = await readPid(file);
    const r = await pending;
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
    await expectDead(pid);
  }, 10000);
});
