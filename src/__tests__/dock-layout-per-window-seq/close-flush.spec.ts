import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadExplorer } from '../../../electron/main/persistence';
import {
  _reset as resetWindowSeq,
  clearWindow,
  getActiveSeqs,
} from '../../../electron/main/services/window-seq.service';

type Listener = (...args: unknown[]) => void;

const electronMock = vi.hoisted(() => {
  const ipcHandlers = new Map<string, Listener[]>();
  const webContentsToWindow = new WeakMap<object, MockBrowserWindow>();
  const windows: MockBrowserWindow[] = [];
  let nextId = 1;
  let userData = '';

  class MockBrowserWindow {
    readonly id = nextId++;
    readonly listeners = new Map<string, Listener[]>();
    destroyed = false;
    readonly webContents = {
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
      getURL: vi.fn(() => ''),
      isDestroyed: vi.fn(() => this.destroyed),
    };
    readonly close = vi.fn(() => {
      const event = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      this.emit('close', event);
      if (!event.defaultPrevented) {
        this.destroyed = true;
        this.emit('closed');
      }
    });
    readonly loadURL = vi.fn();
    readonly loadFile = vi.fn();
    readonly setMenu = vi.fn();
    readonly isDestroyed = vi.fn(() => this.destroyed);
    readonly isMinimized = vi.fn(() => false);
    readonly restore = vi.fn();
    readonly focus = vi.fn();

    constructor() {
      windows.push(this);
      webContentsToWindow.set(this.webContents, this);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }
  }

  return {
    get userData() {
      return userData;
    },
    set userData(value: string) {
      userData = value;
    },
    ipcHandlers,
    windows,
    MockBrowserWindow,
    reset() {
      windows.length = 0;
      userData = '';
    },
    fromWebContents(sender: object) {
      return webContentsToWindow.get(sender) ?? null;
    },
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    name: 'Continuo',
    dock: undefined,
    getPath: vi.fn((name: string) =>
      name === 'userData' ? electronMock.userData : tmpdir(),
    ),
    setPath: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    on: vi.fn(),
    isReady: vi.fn(() => true),
    whenReady: vi.fn(() => new Promise(() => undefined)),
    setAsDefaultProtocolClient: vi.fn(),
  },
  BrowserWindow: Object.assign(electronMock.MockBrowserWindow, {
    fromWebContents: vi.fn((sender: object) =>
      electronMock.fromWebContents(sender),
    ),
    getAllWindows: vi.fn(() => electronMock.windows),
    fromId: vi.fn((id: number) =>
      electronMock.windows.find((w) => w.id === id) ?? null,
    ),
  }),
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    on: vi.fn((channel: string, listener: Listener) => {
      const listeners = electronMock.ipcHandlers.get(channel) ?? [];
      listeners.push(listener);
      electronMock.ipcHandlers.set(channel, listeners);
    }),
    off: vi.fn(),
    handle: vi.fn(),
  },
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => template),
    setApplicationMenu: vi.fn(),
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock('../../../electron/main/ipc', () => ({ registerIpc: vi.fn() }));
vi.mock('../../../electron/main/services/window-restore.service', () => ({
  pickWindowsToRestore: vi.fn(() => []),
}));
vi.mock('../../../electron/main/services/startup-mode.service', () => ({
  pickStartupMode: vi.fn(() => ({ mode: 'restore' })),
}));
vi.mock('../../../electron/main/services/mcp-host.service', () => ({
  createMcpHost: vi.fn(),
  setMcpRevokers: vi.fn(),
}));
vi.mock('../../../electron/main/services/mcp-stdio-server.service', () => ({
  createStdioSocketServer: vi.fn(),
}));
vi.mock('../../../electron/main/services/mcp-tools-terminal', () => ({
  makeListSessionsTool: vi.fn(),
  makeCreateSessionTool: vi.fn(),
  makeSendInputTool: vi.fn(),
  makeSendTextTool: vi.fn(),
  makePressKeyTool: vi.fn(),
  makeReadOutputTool: vi.fn(),
  makeKillTool: vi.fn(),
}));
vi.mock('../../../electron/main/services/terminal-sessions.service', () => ({
  get: vi.fn(),
  getAll: vi.fn(() => []),
}));
vi.mock('../../../electron/main/services/terminal.service', () => ({
  has: vi.fn(() => false),
  write: vi.fn(),
  interrupt: vi.fn(),
  kill: vi.fn(),
  forceKill: vi.fn(),
  readOutput: vi.fn(),
}));
vi.mock('../../../electron/main/ipc/terminal.ipc', () => ({
  makeCreateHandler: vi.fn(() => vi.fn()),
  setMcpEnvProvider: vi.fn(),
}));
vi.mock('../../../electron/main/services/agent-auth.service', () => ({
  requestAgentAuth: vi.fn(),
  setMcpHostRef: vi.fn(),
  cancelAgentAuthByWindow: vi.fn(),
}));
vi.mock('../../../electron/main/services/mcp-stdio-config.service', () => ({
  setStdioConfig: vi.fn(),
}));
vi.mock('../../../electron/main/ipc/plugin-mcp.ipc', () => ({
  startPluginMcpIpc: vi.fn(),
}));

const { createMainWindow, FLUSH_ACK_TIMEOUT_MS } = await import(
  '../../../electron/main/index'
);

let dir: string;

type MockWin = InstanceType<typeof electronMock.MockBrowserWindow>;

function createMockMainWindow(windowSeq: number): MockWin {
  return createMainWindow({ windowSeq }) as unknown as MockWin;
}

beforeEach(async () => {
  vi.useRealTimers();
  electronMock.reset();
  resetWindowSeq();
  dir = await fs.mkdtemp(path.join(tmpdir(), 'continuo-close-flush-'));
  electronMock.userData = dir;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  resetWindowSeq();
  await fs.rm(dir, { recursive: true, force: true });
});

function ack(win: InstanceType<typeof electronMock.MockBrowserWindow>): void {
  const handler = electronMock.ipcHandlers.get('layout:flush-ack')?.[0];
  if (!handler) throw new Error('missing layout:flush-ack handler');
  handler(
    {
      sender: win.webContents,
      senderFrame: { url: 'file:///renderer/index.html' },
    },
    win.id,
  );
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForLastClosedAt(seq: number): Promise<void> {
  await vi.waitFor(async () => {
    const payload = await loadExplorer(path.join(dir, 'explorer.json'));
    expect(payload?.windows.find((w) => w.windowSeq === seq)?.lastClosedAt)
      .toEqual(expect.any(Number));
  });
}

describe('window close layout flush', () => {
  it('T14a: close prevents default, sends flush request, and waits for ack', async () => {
    const win = createMockMainWindow(5);

    win.close();

    expect(win.webContents.send).toHaveBeenCalledWith('layout:flush-request', {
      windowId: win.id,
    });
    expect(win.destroyed).toBe(false);

    ack(win);
    await tick();

    expect(win.destroyed).toBe(true);
    expect(win.close).toHaveBeenCalledTimes(2);
    await waitForLastClosedAt(5);
  });

  it('R45: flush 在途时重复 close 不重发 flush(不覆盖 pending ack)', async () => {
    const win = createMockMainWindow(7);

    win.close(); // 首次 close → 发 flush-request,flush 在途
    win.close(); // flush 未 ack 时再次 close → 应只 preventDefault,不重发

    const flushSends = win.webContents.send.mock.calls.filter(
      (c) => c[0] === 'layout:flush-request',
    );
    expect(flushSends).toHaveLength(1); // 只发一次(旧实现会发两次并覆盖 pending ack)
    expect(win.destroyed).toBe(false);

    ack(win); // 单个 ack 即可结算(未被第二次覆盖)
    await tick();
    expect(win.destroyed).toBe(true);
    await waitForLastClosedAt(7);
  });

  it('T14b: ack completes once and later timer cannot close twice', async () => {
    vi.useFakeTimers();
    const win = createMockMainWindow(5);

    win.close();
    ack(win);
    ack(win);
    await tick();
    await vi.advanceTimersByTimeAsync(1000);

    expect(win.destroyed).toBe(true);
    expect(win.close).toHaveBeenCalledTimes(2);
    await waitForLastClosedAt(5);
  });

  it('T14c: timeout fallback closes when ack never arrives', async () => {
    vi.useFakeTimers();
    const win = createMockMainWindow(5);

    win.close();
    // 数据安全(codex 复查 P1):放宽超时前不应关窗 —— 慢盘合法 flush 不被 1s 切断。
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    expect(win.destroyed).toBe(false); // 1s 时仍在等 ack(旧值会在此误关)

    await vi.advanceTimersByTimeAsync(FLUSH_ACK_TIMEOUT_MS);
    await tick();
    expect(win.destroyed).toBe(true); // 兜底超时仍会关(防挂死)
    expect(win.close).toHaveBeenCalledTimes(2);
    await waitForLastClosedAt(5);
  });

  it('T14f: webContents 已销毁 → flush 立即放行(不空等满超时)', async () => {
    vi.useFakeTimers();
    const win = createMockMainWindow(5);
    win.destroyed = true; // renderer 已不可交互

    win.close();
    await tick();

    // 不需推进任何定时器即关闭(立即放行)
    expect(win.destroyed).toBe(true);
    expect(win.close).toHaveBeenCalledTimes(2);
    await waitForLastClosedAt(5); // 等 closed 持久化完成,避免与 afterEach 删目录竞态
  });

  it('T14d: cross-window ack spoof is ignored', async () => {
    vi.useFakeTimers();
    const win = createMockMainWindow(5);
    const other = createMockMainWindow(6);
    const handlers = electronMock.ipcHandlers.get('layout:flush-ack');
    if (!handlers?.[0]) throw new Error('layout:flush-ack handler missing');
    const handler = handlers[0];

    win.close();
    handler(
      {
        sender: other.webContents,
        senderFrame: { url: 'file:///renderer/index.html' },
      },
      win.id,
    );
    await tick();
    expect(win.destroyed).toBe(false);

    await vi.advanceTimersByTimeAsync(FLUSH_ACK_TIMEOUT_MS);
    await tick();
    expect(win.destroyed).toBe(true);
    await waitForLastClosedAt(5);
  });

  it('T14e: untrusted frame ack is ignored', async () => {
    vi.useFakeTimers();
    const win = createMockMainWindow(5);
    const handlers = electronMock.ipcHandlers.get('layout:flush-ack');
    if (!handlers?.[0]) throw new Error('layout:flush-ack handler missing');
    const handler = handlers[0];

    win.close();
    handler(
      {
        sender: win.webContents,
        senderFrame: { url: 'https://evil.example/' },
      },
      win.id,
    );
    await tick();
    expect(win.destroyed).toBe(false);

    await vi.advanceTimersByTimeAsync(FLUSH_ACK_TIMEOUT_MS);
    await tick();
    expect(win.destroyed).toBe(true);
    await waitForLastClosedAt(5);
  });

  it('T20a: closed handler uses cached seq and writes lastClosedAt even if map was cleared', async () => {
    const win = createMockMainWindow(9);
    clearWindow(win.id);
    const before = Date.now();

    win.close();
    ack(win);
    await vi.waitFor(async () => {
      const payload = await loadExplorer(path.join(dir, 'explorer.json'));
      expect(payload?.windows.find((w) => w.windowSeq === 9)?.lastClosedAt)
        .toBeGreaterThanOrEqual(before);
    });
  });

  it('T20b: closed window is removed from active seqs while lastClosedAt is persisted', async () => {
    const win = createMockMainWindow(10);

    win.close();
    ack(win);
    await vi.waitFor(async () => {
      const payload = await loadExplorer(path.join(dir, 'explorer.json'));
      expect(payload?.windows.find((w) => w.windowSeq === 10)?.lastClosedAt)
        .toEqual(expect.any(Number));
    });

    expect(getActiveSeqs().has(10)).toBe(false);
  });
});
