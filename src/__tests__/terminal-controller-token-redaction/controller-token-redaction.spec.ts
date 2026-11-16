// 安全:agent 会话的 controllerToken(HTTP 下即 bearer token)此前经 list_sessions / sessions_changed
// 原样发给 renderer —— getAll 返回 main 内部 MainTerminalSession 对象,IPC 没投影成 renderer 快照。

import { afterEach, describe, expect, it, vi } from 'vitest';

type FakeWin = {
  id: number;
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
};

const mocks = vi.hoisted(() => ({ windows: [] as FakeWin[] }));

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => mocks.windows },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import * as terminalSessions from '../../../electron/main/services/terminal-sessions.service';
import {
  broadcastSessionsChanged,
  makeListSessionsHandler,
} from '../../../electron/main/ipc/terminal.ipc';
import { TERMINAL_CHANNELS } from '../../../electron/shared/terminal-channels';

const SECRET = 'bearer-secret-token';

function addAgentSession(): void {
  terminalSessions.add({
    id: 'term-agent',
    title: 'codex',
    cwd: '/work',
    originHint: 'agent',
    agentLabel: 'codex',
    ownerWindowId: 7,
    controllerToken: SECRET,
  });
}

afterEach(() => {
  terminalSessions._reset();
  mocks.windows = [];
});

describe('controllerToken 不跨 IPC 到 renderer', () => {
  it('list_sessions 返回不含 controllerToken,其余字段保留', () => {
    addAgentSession();
    const { sessions } = makeListSessionsHandler()({ ownerWindowId: 7 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).not.toHaveProperty('controllerToken');
    expect(JSON.stringify(sessions)).not.toContain(SECRET);
    expect(sessions[0]).toMatchObject({ id: 'term-agent', agentLabel: 'codex', ownerWindowId: 7 });
  });

  it('sessions_changed 广播快照不含 controllerToken', () => {
    addAgentSession();
    const send = vi.fn();
    mocks.windows = [{ id: 7, isDestroyed: () => false, webContents: { send } }];
    broadcastSessionsChanged();
    expect(send).toHaveBeenCalledWith(TERMINAL_CHANNELS.SESSIONS_CHANGED, expect.any(Array));
    expect(JSON.stringify(send.mock.calls)).not.toContain(SECRET);
  });

  it('main 内部 capability 校验仍能读到 controllerToken', () => {
    addAgentSession();
    expect(terminalSessions.getController('term-agent')).toBe(SECRET);
  });
});
