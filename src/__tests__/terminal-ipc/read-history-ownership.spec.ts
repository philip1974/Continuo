import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_CHANNELS } from '../../../electron/shared/terminal-channels';
import { registerTerminalIpc } from '../../../electron/main/ipc/terminal.ipc';
import * as terminalSessions from '../../../electron/main/services/terminal-sessions.service';
import * as terminalBuffer from '../../../electron/main/services/terminal-buffer.service';

type IpcHandler = (event: unknown, raw: unknown) => Promise<unknown>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  const senderToWindow = new Map<object, { id: number; isDestroyed: () => boolean }>();
  const windows: Array<{
    id: number;
    isDestroyed: () => boolean;
    once: ReturnType<typeof vi.fn>;
    webContents: { send: ReturnType<typeof vi.fn> };
  }> = [];

  return {
    handlers,
    senderToWindow,
    windows,
    appOn: vi.fn(),
    reset() {
      handlers.clear();
      senderToWindow.clear();
      windows.length = 0;
      this.appOn.mockClear();
    },
  };
});

vi.mock('electron', () => ({
  app: {
    on: electronMock.appOn,
  },
  BrowserWindow: {
    fromWebContents: vi.fn((sender: object) => electronMock.senderToWindow.get(sender) ?? null),
    getAllWindows: vi.fn(() => electronMock.windows),
    fromId: vi.fn((id: number) => electronMock.windows.find((w) => w.id === id) ?? null),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronMock.handlers.set(channel, handler);
    }),
  },
}));

const senderA = {};

function makeWin(id: number) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    once: vi.fn(),
    webContents: { send: vi.fn() },
  };
}

function eventFor(sender: object) {
  return {
    sender,
    senderFrame: { url: 'file:///renderer/index.html' },
  };
}

async function invokeReadHistory(id: string) {
  const handler = electronMock.handlers.get(TERMINAL_CHANNELS.READ_HISTORY);
  expect(handler).toBeDefined();
  return handler!(eventFor(senderA), { id });
}

describe('terminal:read_history ownership', () => {
  beforeEach(() => {
    electronMock.reset();
    terminalSessions._reset();
    terminalBuffer._resetForTest();

    const winA = makeWin(10);
    const winB = makeWin(20);
    electronMock.windows.push(winA, winB);
    electronMock.senderToWindow.set(senderA, winA);

    terminalSessions.add({
      id: 'A-id',
      title: 'A',
      cwd: '/a',
      originHint: 'user',
      ownerWindowId: 10,
    });
    terminalSessions.add({
      id: 'B-id',
      title: 'B',
      cwd: '/b',
      originHint: 'user',
      ownerWindowId: 20,
    });
    terminalBuffer.append('A-id', 'A raw');
    terminalBuffer.append('B-id', 'B raw');

    registerTerminalIpc();
  });

  it('T4 - sender=A read_history with B id returns TERMINAL_NOT_FOUND', async () => {
    await expect(invokeReadHistory('B-id')).resolves.toMatchObject({
      ok: false,
      code: 'TERMINAL_NOT_FOUND',
    });
  });

  it('T5 - sender=A read_history with A id returns raw history', async () => {
    await expect(invokeReadHistory('A-id')).resolves.toEqual({
      ok: true,
      data: { data: 'A raw', truncated: false },
    });
  });

  it('T6 - sender=A read_history with nonexistent id returns TERMINAL_NOT_FOUND', async () => {
    await expect(invokeReadHistory('missing-id')).resolves.toMatchObject({
      ok: false,
      code: 'TERMINAL_NOT_FOUND',
    });
  });
});
