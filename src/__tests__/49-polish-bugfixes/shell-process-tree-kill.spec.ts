// 流式 shell / 一次性 exec 终止时须杀整棵进程树:旧实现只杀直接子进程,`sh -c 'sleep 600 & wait'`
// 超时/abort 后后台 sleep 成孤儿继续跑并持有 stdout/stderr 管道 → close 迟迟不来,done / active 槽位
// (exec 的 Promise)挂住。真实子进程验证:后代把自己的 pid 写进临时文件,结束后断言其已不存在(ESRCH)。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../../electron/shared/plugin-shell-stream-channels';
import {
  cleanupAllShellStreams,
  registerPluginShellStreamHandlers,
  resetShellStreamShutdownForTest,
} from '../../../electron/main/services/plugin-shell-stream.service';
import {
  cleanupAllShellExecs,
  execShell,
  resetShellExecShutdownForTest,
} from '../../../electron/main/services/shell.service';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
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
// 按测试自己记录的 pid 清理。「逃逸后代」用例依赖这里:主动脱离原进程组的后代整组信号够不着(已知边界,
// 见下),不手动清理会泄漏到测试进程之外;这不是掩盖缺陷,那两条用例本就不断言后代被杀。
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  // cleanupAll 置的退出闸是模块级状态,用例之间复位。
  resetShellExecShutdownForTest();
  resetShellStreamShutdownForTest();
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

  // 后代忽略 SIGTERM 且不持管道(stdio 重定向 /dev/null):整组 SIGTERM 后直接子进程 sh 先退出 → close 立刻到达。
  // 结算不得取消宽限期后的整组 SIGKILL,否则同组内这个后代存活成孤儿。
  const termIgnorer = (file: string): string[] => [
    '-c',
    `sh -c "trap '' TERM; while :; do sleep 1; done" </dev/null >/dev/null 2>&1 & echo $! > '${file}'; wait`,
  ];

  it('execShell 超时且直接子进程先退出 → 同组内忽略 SIGTERM 的后代仍在宽限期后被 SIGKILL', async () => {
    const file = pidFile();
    const pending = execShell({ cmd: '/bin/sh', args: termIgnorer(file), timeoutMs: 300 });
    const pid = await readPid(file);
    const r = await pending;
    expect(r.timedOut).toBe(true);
    await expectDead(pid);
  }, 10000);

  it('stream 超时且直接子进程先退出 → 同组内忽略 SIGTERM 的后代仍在宽限期后被 SIGKILL', async () => {
    const { ipc, event } = harness();
    const file = pidFile();
    await ipc.invokeWithEvent(event, PLUGIN_SHELL_STREAM_CHANNELS.START, 'term-ignorer', '/bin/sh', termIgnorer(file), {
      timeoutMs: 300,
    });
    const pid = await readPid(file);
    await waitUntil(
      () => events(event).find((e) => e.streamId === 'term-ignorer' && e.kind === 'exit'),
      'exit after timeout',
    );
    await expectDead(pid);
  }, 10000);

  // 已知边界(与 VSCode tasks 一致,不修):后代主动 setsid / `detached` 脱离原进程组后,整组信号够不着它。
  // 它仍持 stdout/stderr 管道 → close 永不来。以下两条只断言「终止后及时强制结算、不无限挂住」,
  // **不断言**该后代被杀(它确实存活,由 afterEach 按 pid 清理)。
  const escaper = (file: string): string[] => [
    '-e',
    `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});require('fs').writeFileSync(${JSON.stringify(file)},String(c.pid));setInterval(()=>{},1000)`,
  ];

  it('stream 超时且后代脱离进程组持管道 → 及时强制结算 exit、不挂住(不断言后代被杀:已知边界)', async () => {
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

  it('execShell 超时且后代脱离进程组持管道 → 及时强制 resolve、不挂住(不断言后代被杀:已知边界)', async () => {
    const file = pidFile();
    const pending = execShell({ cmd: process.execPath, args: escaper(file), timeoutMs: 300 });
    await readPid(file);
    const r = await pending;
    expect(r.timedOut).toBe(true);
  }, 10000);

  // 退出清理:before-quit 此前只 await terminal/debug/MCP 清理;一次性 exec 无退出清理,流式只在 webContents
  // 销毁后走 SIGTERM + 未被等待的定时 SIGKILL;子进程是 detached 进程组 → IDE 退出后命令继续运行。
  // cleanupAll 对所有在途进程树立即 SIGKILL 并等待 close(有上限),纳入 before-quit 的 awaited 清理。
  it('execShell 在途 → cleanupAllShellExecs 立即杀整棵进程树(含忽略 SIGTERM 的后代),Promise 结算', async () => {
    const file = pidFile();
    const pending = execShell({ cmd: '/bin/sh', args: termIgnorer(file), timeoutMs: 600_000 });
    const pid = await readPid(file);
    await cleanupAllShellExecs();
    await expectDead(pid); // 已 SIGKILL;留给 launchd/init 回收孤儿僵尸的余量
    const r = await pending;
    expect(r.timedOut).toBe(false);
    await expect(cleanupAllShellExecs()).resolves.toBeUndefined(); // 无在途 → 立即返回
  }, 10000);

  it('stream 在途 → cleanupAllShellStreams 立即杀整棵进程树(含忽略 SIGTERM 的后代),exit 到达', async () => {
    const { ipc, event } = harness();
    const file = pidFile();
    await ipc.invokeWithEvent(event, PLUGIN_SHELL_STREAM_CHANNELS.START, 'quit-tree', '/bin/sh', termIgnorer(file), {
      timeoutMs: 600_000,
    });
    const pid = await readPid(file);
    await cleanupAllShellStreams();
    await expectDead(pid); // 已 SIGKILL;留给 launchd/init 回收孤儿僵尸的余量
    await waitUntil(
      () => events(event).find((e) => e.streamId === 'quit-tree' && e.kind === 'exit'),
      'exit after cleanup',
    );
  }, 10000);

  // 终审 P1:cleanupAll 只杀调用瞬间的快照。插件收到 exit 后立即重启任务,新进程在最终 app.quit 前启动、不在
  // 快照内,detached 进程组在 IDE 退出后存活。cleanupAll 开始即置退出闸:此后 exec / START 立即拒绝且不 spawn。
  // 被拒的命令若真的 spawn 了会把自己的 pid 写进文件;断言文件始终不出现。
  const marker = (file: string): string[] => ['-c', `echo $$ > '${file}'; sleep 600`];
  async function expectNeverSpawned(file: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 300));
    if (existsSync(file)) pids.push(Number(readFileSync(file, 'utf-8').trim()));
    expect(existsSync(file)).toBe(false);
  }

  it('cleanupAllShellExecs 进行中(在途 exec 结算时重启)与之后 → execShell 拒绝且不 spawn', async () => {
    const file = pidFile();
    const pending = execShell({ cmd: '/bin/sh', args: termIgnorer(file), timeoutMs: 600_000 });
    await readPid(file);
    const restartFile = pidFile();
    // 在途 exec 被清理强杀后结算 —— 此刻清理尚未结束,插件立即重启任务。
    const restarted = pending.then(() =>
      execShell({ cmd: '/bin/sh', args: marker(restartFile), timeoutMs: 600_000 }),
    );
    const cleanup = cleanupAllShellExecs();
    await expect(restarted).rejects.toMatchObject({ code: ERROR_CODES.AGENT_NOT_AUTHORIZED });
    await cleanup;
    const afterFile = pidFile();
    await expect(
      execShell({ cmd: '/bin/sh', args: marker(afterFile), timeoutMs: 600_000 }),
    ).rejects.toMatchObject({ code: ERROR_CODES.AGENT_NOT_AUTHORIZED });
    await expectNeverSpawned(restartFile);
    await expectNeverSpawned(afterFile);
  }, 10000);

  it('cleanupAllShellStreams 进行中(收到 exit 事件即重启)与之后 → START 拒绝且不 spawn', async () => {
    const { ipc, event } = harness();
    const file = pidFile();
    const restartFile = pidFile();
    let restarted: Promise<unknown> | undefined;
    event.sender.send.mockImplementation((_channel: string, ev: StreamEvent) => {
      if (ev.streamId === 'quit-restart' && ev.kind === 'exit' && !restarted) {
        restarted = ipc.invokeWithEvent(event, PLUGIN_SHELL_STREAM_CHANNELS.START, 'quit-restart-2', '/bin/sh', marker(restartFile), {
          timeoutMs: 600_000,
        });
      }
    });
    await ipc.invokeWithEvent(event, PLUGIN_SHELL_STREAM_CHANNELS.START, 'quit-restart', '/bin/sh', termIgnorer(file), {
      timeoutMs: 600_000,
    });
    await readPid(file);
    await cleanupAllShellStreams();
    expect(restarted).toBeDefined();
    await expect(restarted).rejects.toMatchObject({ code: ERROR_CODES.AGENT_NOT_AUTHORIZED });
    const afterFile = pidFile();
    await expect(
      ipc.invokeWithEvent(event, PLUGIN_SHELL_STREAM_CHANNELS.START, 'quit-after', '/bin/sh', marker(afterFile)),
    ).rejects.toMatchObject({ code: ERROR_CODES.AGENT_NOT_AUTHORIZED });
    await expectNeverSpawned(restartFile);
    await expectNeverSpawned(afterFile);
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
