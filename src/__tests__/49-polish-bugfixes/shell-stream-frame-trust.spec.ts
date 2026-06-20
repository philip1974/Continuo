// topic 49 第十二 session · codex 复审 loop R8:plugin-shell-stream START/ABORT 必须 frame-trust 门控。
//
// 根因:PLUGIN_SHELL_STREAM_CHANNELS.START / ABORT 手写 ipcMain.handle,没走 safeHandle 也没
// 校验 defaultIsTrustedFrame。START 在 main 端直接 spawn(cmd, args),而 'shell' 权限只在
// renderer 的 scoped-app 包装层检查 → 能触达 raw IPC 的不可信 frame(ADR-Plugin-5 隔离 iframe)
// 可绕过权限边界触发本机命令执行。同仓所有写/敏感 IPC 都校验 senderFrame(R7 / P2-AD)。
//
// 修:START + ABORT 开头校验 defaultIsTrustedFrame,不可信抛 IPC_ERR.DENIED;ABORT 另加
// senderId 归属校验,防跨 sender 终止别人的 stream。
//
// 本 spec 注入一个会记录调用的假 spawn(不真起进程),断言不可信 frame 调 START 时不 spawn。

import { describe, it, expect, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { registerPluginShellStreamHandlers } from '../../../electron/main/services/plugin-shell-stream.service';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../../electron/shared/plugin-shell-stream-channels';
import { IPC_ERR } from '../../../electron/shared/ipc-result';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function makeIpc(): { handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  registerPluginShellStreamHandlers({
    handle: (ch: string, fn: Handler) => handlers.set(ch, fn),
  } as never);
  return { handlers };
}

function evt(frameUrl: string | null, id = 1): unknown {
  return {
    sender: { id, send: vi.fn(), isDestroyed: () => false, once: undefined },
    senderFrame: frameUrl === null ? null : { url: frameUrl },
  };
}

describe('topic49 codex-loop R8 · shell-stream frame-trust', () => {
  it('不可信 frame 调 START → DENIED 且不 spawn 子进程', async () => {
    spawnMock.mockClear();
    const { handlers } = makeIpc();
    const start = handlers.get(PLUGIN_SHELL_STREAM_CHANNELS.START)!;

    await expect(
      start(evt('https://evil.example/'), 's1', 'rm', ['-rf', '/']),
    ).rejects.toMatchObject({ code: IPC_ERR.DENIED });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('缺失 senderFrame(null)调 START → DENIED 且不 spawn,fail-closed', async () => {
    spawnMock.mockClear();
    const { handlers } = makeIpc();
    const start = handlers.get(PLUGIN_SHELL_STREAM_CHANNELS.START)!;

    await expect(
      start(evt(null), 's2', 'whoami', []),
    ).rejects.toMatchObject({ code: IPC_ERR.DENIED });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('不可信 frame 调 ABORT → DENIED', async () => {
    const { handlers } = makeIpc();
    const abort = handlers.get(PLUGIN_SHELL_STREAM_CHANNELS.ABORT)!;
    await expect(
      abort(evt('https://evil.example/'), 's1'),
    ).rejects.toMatchObject({ code: IPC_ERR.DENIED });
  });
});
