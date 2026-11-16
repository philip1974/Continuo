// 停用/卸载插件终止它启动的 shell 进程(终审 P1)。真实子进程:后代把自己的 pid 写进临时文件,
// 终止后断言其已不存在(ESRCH);未匹配的进程断言仍存活。见同目录 README.md。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => {
      h.handlers.set(channel, fn);
    },
  },
  shell: {},
  BrowserWindow: {},
}));

import { SHELL_CHANNELS } from '../../../electron/shared/shell-channels';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../../electron/shared/plugin-shell-stream-channels';
import { registerShellIpc } from '../../../electron/main/ipc/shell.ipc';
import { cleanupAllShellExecs } from '../../../electron/main/services/shell.service';
import {
  cleanupAllShellStreams,
  registerPluginShellStreamHandlers,
} from '../../../electron/main/services/plugin-shell-stream.service';
import { StubIpcMain, makeFakeEvent, type StubIpcEvent } from '../sdk-contract/integration/make-stub-ipc';

// 进程组 / `sh` 语义仅 POSIX(同 49-polish-bugfixes/shell-process-tree-kill)。
const HAS_SH = process.platform !== 'win32' && existsSync('/bin/sh');

const dirs: string[] = [];
const pids: number[] = [];
// 只按测试自己记录的 pid 清理(不 pkill),再走在途清理兜底。
afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出
    }
  }
  await cleanupAllShellExecs();
  await cleanupAllShellStreams();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function pidFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'plugin-shell-kill-'));
  dirs.push(d);
  return join(d, 'pid');
}

// 后台 sleep 写出自己的 pid 后 sh 等待它。
function script(file: string): string[] {
  return ['-c', `sleep 600 & echo $! > '${file}'; wait`];
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

function invoke(channel: string, event: StubIpcEvent, raw: unknown): Promise<unknown> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`missing handler ${channel}`);
  return fn(event, raw);
}

function exec(event: StubIpcEvent, pluginId: string, file: string): Promise<unknown> {
  return invoke(SHELL_CHANNELS.EXEC, event, {
    cmd: '/bin/sh',
    args: script(file),
    timeoutMs: 600_000,
    pluginId,
  });
}

function killPlugin(event: StubIpcEvent, pluginId: string): Promise<unknown> {
  return invoke(SHELL_CHANNELS.KILL_PLUGIN_PROCESSES, event, { pluginId });
}

describe.skipIf(!HAS_SH)('main:按 (窗口, 插件) 终止 shell 进程树', () => {
  it('shell.exec:只终止发送方窗口内该插件的进程;同窗口其它插件、其它窗口同 id 插件不受影响', async () => {
    h.handlers.clear();
    registerShellIpc();
    const win1 = makeFakeEvent({ id: 1 });
    const win2 = makeFakeEvent({ id: 2 });
    const fA1 = pidFile();
    const fB1 = pidFile();
    const fA2 = pidFile();
    const target = exec(win1, 'com.x.a', fA1);
    void exec(win1, 'com.x.b', fB1);
    void exec(win2, 'com.x.a', fA2);
    const [pA1, pB1, pA2] = [await readPid(fA1), await readPid(fB1), await readPid(fA2)];

    await expect(killPlugin(win1, 'com.x.a')).resolves.toMatchObject({ ok: true });

    await expectDead(pA1);
    await expect(target).resolves.toMatchObject({ ok: true, data: { timedOut: false } });
    expect(isAlive(pB1)).toBe(true);
    expect(isAlive(pA2)).toBe(true);
  }, 10000);

  it('流式 execStream:终止该插件的流 → 后代被杀、exit 及时到达;同窗口其它插件的流不受影响', async () => {
    h.handlers.clear();
    registerShellIpc();
    const ipc = new StubIpcMain();
    registerPluginShellStreamHandlers(ipc as never);
    const win1 = makeFakeEvent({ id: 1 });
    const fA = pidFile();
    const fB = pidFile();
    await ipc.invokeWithEvent(win1, PLUGIN_SHELL_STREAM_CHANNELS.START, 's-a', '/bin/sh', script(fA), {
      timeoutMs: 600_000,
      pluginId: 'com.x.a',
    });
    await ipc.invokeWithEvent(win1, PLUGIN_SHELL_STREAM_CHANNELS.START, 's-b', '/bin/sh', script(fB), {
      timeoutMs: 600_000,
      pluginId: 'com.x.b',
    });
    const [pA, pB] = [await readPid(fA), await readPid(fB)];

    await expect(killPlugin(win1, 'com.x.a')).resolves.toMatchObject({ ok: true });

    await expectDead(pA);
    await waitUntil(
      () =>
        win1.sender.send.mock.calls.find(
          (c) => c[0] === PLUGIN_SHELL_STREAM_CHANNELS.EVENT && c[1].streamId === 's-a' && c[1].kind === 'exit',
        ),
      'exit of s-a',
    );
    expect(isAlive(pB)).toBe(true);
  }, 10000);

  it('不受信 frame → 拒绝,不终止任何进程', async () => {
    h.handlers.clear();
    registerShellIpc();
    const win1 = makeFakeEvent({ id: 1 });
    const f = pidFile();
    void exec(win1, 'com.x.a', f);
    const pid = await readPid(f);

    const untrusted = makeFakeEvent({ id: 1, senderFrame: { url: 'https://evil.example/' } });
    await expect(killPlugin(untrusted, 'com.x.a')).resolves.toMatchObject({ ok: false });
    expect(isAlive(pid)).toBe(true);
  }, 10000);
});
