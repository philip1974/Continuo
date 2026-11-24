// 撤销是全局动作(终止**所有窗口**的 agent terminal),确认框的数量须取 main 的全局计数,不能只算本窗口。
// 本文件钉 main 侧计数通道:返回全部窗口 agent 终端数,且与其它 IPC 一样只受理受信 frame。见同目录 README「撤销确认框的数量」。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerIpc } from '../../../electron/main/ipc';
import { AGENT_AUTH_CHANNELS } from '../../../electron/shared/agent-auth-channels';
import { IPC_ERR } from '../../../electron/shared/ipc-result';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  count: vi.fn(() => 3),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => {
      h.handlers.set(channel, fn);
    }),
  },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: () => [] },
}));

vi.mock('../../../electron/main/ipc/fs.ipc', () => ({ registerFsIpc: vi.fn() }));
vi.mock('../../../electron/main/ipc/terminal.ipc', () => ({ registerTerminalIpc: vi.fn() }));
vi.mock('../../../electron/main/ipc/plugins.ipc', () => ({ registerPluginsIpc: vi.fn() }));
vi.mock('../../../electron/main/ipc/shell.ipc', () => ({ registerShellIpc: vi.fn() }));
vi.mock('../../../electron/main/ipc/window.ipc', () => ({ registerWindowIpc: vi.fn() }));
vi.mock('../../../electron/main/services/agent-auth.service', () => ({
  answerAgentAuthRequest: vi.fn(),
  revokeAndKillAgentSessions: vi.fn(),
  countAgentTerminalSessions: h.count,
}));
vi.mock('../../../electron/main/services/mcp-stdio-config.service', () => ({
  getStdioConfig: vi.fn(),
}));

function invoke(frameUrl: string, raw: unknown = {}): Promise<unknown> {
  const fn = h.handlers.get(AGENT_AUTH_CHANNELS.COUNT_AGENT_TERMINALS);
  if (!fn) throw new Error('missing handler');
  return fn({ sender: {}, senderFrame: { url: frameUrl } }, raw);
}

beforeEach(() => {
  h.handlers.clear();
  h.count.mockClear();
  registerIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn() });
});

describe('撤销确认用的全局 agent 终端计数(main IPC)', () => {
  it('受信 frame → 返回 main 全局计数(所有窗口)', async () => {
    await expect(invoke('file:///renderer/index.html')).resolves.toEqual({ ok: true, data: { count: 3 } });
    expect(h.count).toHaveBeenCalledTimes(1);
  });

  it('不受信 frame → DENIED,不读会话', async () => {
    const r = await invoke('https://evil.example/');
    expect(r).toMatchObject({ ok: false, code: IPC_ERR.DENIED });
    expect(h.count).not.toHaveBeenCalled();
  });

  it('多余入参 → BAD_INPUT', async () => {
    const r = await invoke('file:///renderer/index.html', { windowId: 1 });
    expect(r).toMatchObject({ ok: false, code: IPC_ERR.BAD_INPUT });
    expect(h.count).not.toHaveBeenCalled();
  });
});
