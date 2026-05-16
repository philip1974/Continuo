// topic-13 window-ipc-create: createWindowHandler BDD pin.
// ★ 严格 BDD-only: 不修改任何 source 文件 (包括 topic-12 spec 与本文件 source 依赖).
// ★ 不抽 shared helper 到 src/__tests__/_shared/ 或别处 — 本 helper 局部使用, 不 export.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';
import { registerWindowIpc } from '../../../electron/main/ipc/window.ipc';

type Listener = (...args: unknown[]) => void;
type InvokeHandler = (
  event: { sender: object; senderFrame: { url: string } },
  raw: unknown,
) => unknown;

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  appListeners: new Map<string, Listener[]>(),
  senderToWindow: new Map<object, { id: number }>(),
}));

const fsMock = vi.hoisted(() => ({
  statSync: vi.fn(),
}));

// 关键: vi.mock 三层缺一不可, 防 node:fs mock 漏到 electron/main/index 真 import:
// - electron/main/index (createMainWindow) — 防 index.ts 的 node:fs side-effect
// - electron/main/persistence (allocateWindowSeq) — 防 persistence.ts 的 node:fs 使用
// - node:fs (statSync) — window.ipc.ts 直接用, mock 它控制 throw / isDirectory

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    on: vi.fn((event: string, listener: Listener) => {
      const listeners = electronMock.appListeners.get(event) ?? [];
      listeners.push(listener);
      electronMock.appListeners.set(event, listeners);
    }),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      electronMock.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(
      (sender: object) => electronMock.senderToWindow.get(sender) ?? null,
    ),
  },
}));

vi.mock('../../../electron/main/index', () => ({
  createMainWindow: vi.fn(() => ({ id: 42 })),
}));

vi.mock('../../../electron/main/persistence', () => ({
  allocateWindowSeq: vi.fn(async () => 7),
}));

vi.mock('node:fs', () => ({
  statSync: fsMock.statSync,
}));

import { createMainWindow } from '../../../electron/main/index';
import { allocateWindowSeq } from '../../../electron/main/persistence';

const sender = {};
const fakeWindow = { id: 99 };

function createWin(input: unknown): unknown {
  const handler = electronMock.handlers.get(WINDOW_CHANNELS.CREATE);
  if (!handler) throw new Error('missing CREATE handler');
  // P0-1 (rt-v1): safeHandle.defaultIsTrustedFrame 校验 senderFrame, 必须 mock 可信 frame
  return handler(
    { sender, senderFrame: { url: 'file:///renderer/index.html' } },
    input,
  );
}

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.appListeners.clear();
  electronMock.senderToWindow.clear();
  electronMock.senderToWindow.set(sender, fakeWindow);
  vi.clearAllMocks();
  fsMock.statSync.mockReset();
  registerWindowIpc();
});

describe('window-ipc-create: createWindowHandler', () => {
  it("T1: rejects relative workspace as WORKSPACE_NOT_ABSOLUTE", async () => {
    const result = await createWin({ workspace: './x' });
    expect(result).toMatchObject({
      ok: false,
      code: 'WORKSPACE_NOT_ABSOLUTE',
    });
  });

  it("T2: rejects non-existent absolute workspace as WORKSPACE_NOT_FOUND", async () => {
    fsMock.statSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const result = await createWin({ workspace: '/nonexistent/path' });
    expect(result).toMatchObject({
      ok: false,
      code: 'WORKSPACE_NOT_FOUND',
    });
  });

  it("T3: rejects file (not directory) as WORKSPACE_NOT_DIRECTORY", async () => {
    fsMock.statSync.mockReturnValue({ isDirectory: () => false } as never);
    const result = await createWin({ workspace: '/abs/file' });
    expect(result).toMatchObject({
      ok: false,
      code: 'WORKSPACE_NOT_DIRECTORY',
    });
  });

  it("T4: accepts a valid absolute directory and creates the window", async () => {
    fsMock.statSync.mockReturnValue({ isDirectory: () => true } as never);
    const result = await createWin({ workspace: '/abs/path' });
    expect(result).toEqual({ ok: true, data: { windowId: 42 } });
    expect(allocateWindowSeq).toHaveBeenCalledTimes(1);
    expect(createMainWindow).toHaveBeenCalledTimes(1);
    expect(createMainWindow).toHaveBeenCalledWith(
      expect.objectContaining({ windowSeq: 7, workspace: '/abs/path' }),
    );
  });

  it("T5: omits workspace when input has no workspace field", async () => {
    const result = await createWin({});
    expect(result).toEqual({ ok: true, data: { windowId: 42 } });
    expect(allocateWindowSeq).toHaveBeenCalledTimes(1);
    expect(createMainWindow).toHaveBeenCalledTimes(1);
    const firstCallArgs = (
      createMainWindow as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0]?.[0];
    expect(firstCallArgs).not.toHaveProperty('workspace');
    expect(firstCallArgs).toHaveProperty('windowSeq', 7);
  });

  it("T6: CreateInput .strict() rejects unknown field as IPC_BAD_INPUT", async () => {
    const result = await createWin({ workspace: '/a', foo: 'bar' });
    expect(result).toMatchObject({
      ok: false,
      code: 'IPC_BAD_INPUT',
    });
  });

  it("T7: workspace='' fails zod .min(1) as IPC_BAD_INPUT", async () => {
    const result = await createWin({ workspace: '' });
    expect(result).toMatchObject({
      ok: false,
      code: 'IPC_BAD_INPUT',
    });
  });
});
