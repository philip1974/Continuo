import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  defaultExplorerV3,
  loadExplorer,
  MAX_PERSISTED_WINDOW_SEGMENTS,
} from '../../../electron/main/persistence';
import {
  _reset as resetWindowSeq,
  clearWindow,
  getActiveSeqs,
} from '../../../electron/main/services/window-seq.service';
import { flushMicrotasks } from '../_helpers/async';

type Listener = (...args: unknown[]) => void;

const electronMock = vi.hoisted(() => {
  const ipcHandlers = new Map<string, Listener[]>();
  const appHandlers = new Map<string, Listener[]>();
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
    readonly hide = vi.fn();
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
    appHandlers,
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
    commandLine: {
      getSwitchValue: vi.fn(() => ''),
    },
    setPath: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    on: vi.fn((event: string, listener: Listener) => {
      const listeners = electronMock.appHandlers.get(event) ?? [];
      listeners.push(listener);
      electronMock.appHandlers.set(event, listeners);
    }),
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
  isStartupRestoreInFlight: vi.fn(() => false),
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
  cleanupAll: vi.fn(async () => undefined),
  readOutput: vi.fn(),
}));
vi.mock('../../../electron/main/ipc/terminal.ipc', () => ({
  makeAgentCreateSession: vi.fn(() => vi.fn()),
  setMcpEnvProvider: vi.fn(),
}));
vi.mock('../../../electron/main/services/agent-auth.service', () => ({
  requestAgentAuth: vi.fn(),
  setMcpHostRef: vi.fn(),
  cancelAgentAuthByWindow: vi.fn(),
  cancelAllAgentAuth: vi.fn(),
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

/** 模拟 renderer 挂载完成后经 preload 上报「已订阅 flush 请求」。 */
function markFlushReady(win: MockWin): void {
  const handler = electronMock.ipcHandlers.get('layout:flush-ready')?.[0];
  if (!handler) throw new Error('missing layout:flush-ready handler');
  handler({
    sender: win.webContents,
    senderFrame: { url: 'file:///renderer/index.html' },
  });
}

/** 默认建一个 renderer 已就绪的主窗(绝大多数用例关心的是握手本身)。 */
function createMockMainWindow(windowSeq: number, opts: { ready?: boolean } = {}): MockWin {
  const win = createMainWindow({ windowSeq }) as unknown as MockWin;
  if (opts.ready !== false) markFlushReady(win);
  return win;
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
  // 在途的异步写盘可能与清理并发 → ENOTEMPTY;maxRetries 让 fs.rm 对这类暂时性错误重试。
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** 该窗口最近一次 flush 请求的回执体(renderer 原样带回 requestId;main 只结算匹配的回执)。 */
function ackBody(win: InstanceType<typeof electronMock.MockBrowserWindow>): { requestId?: unknown } {
  const calls = (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
    (c) => c[0] === 'layout:flush-request',
  );
  const last = calls[calls.length - 1]?.[1] as { requestId?: unknown } | undefined;
  // 必须真的取到 requestId:否则「跨窗伪造 / 不受信 frame」用例会因缺 requestId 被拒而假通过。
  expect(last?.requestId).toEqual(expect.any(Number));
  return { requestId: last?.requestId };
}

function ack(win: InstanceType<typeof electronMock.MockBrowserWindow>): void {
  const handler = electronMock.ipcHandlers.get('layout:flush-ack')?.[0];
  if (!handler) throw new Error('missing layout:flush-ack handler');
  handler(
    {
      sender: win.webContents,
      senderFrame: { url: 'file:///renderer/index.html' },
    },
    win.id,
    ackBody(win),
  );
}

async function waitForLastClosedAt(seq: number): Promise<void> {
  await vi.waitFor(async () => {
    const payload = await loadExplorer(path.join(dir, 'explorer.json'));
    expect(payload?.windows.find((w) => w.windowSeq === seq)?.lastClosedAt)
      .toEqual(expect.any(Number));
  });
}

// renderer 还没订阅 flush 请求(启动中 / 加载失败)时没有任何东西可落盘,也没人会回 ack。
// 此前照样发请求并干等满 10s 超时(窗口已隐藏,但进程多挂 10s;e2e 里「启动即关」的用例因此每个多花 10s)。
describe('renderer 未就绪时关窗', () => {
  it('不发 flush 请求、不等超时,直接关闭', async () => {
    vi.useFakeTimers();
    const win = createMockMainWindow(7, { ready: false });

    win.close();
    await flushMicrotasks(2);

    expect(win.webContents.send).not.toHaveBeenCalledWith('layout:flush-request', expect.anything());
    expect(win.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('就绪上报来自不受信 frame 或别的窗口 → 不算就绪', async () => {
    vi.useFakeTimers();
    const win = createMockMainWindow(8, { ready: false });
    const handler = electronMock.ipcHandlers.get('layout:flush-ready')![0]!;
    handler({ sender: win.webContents, senderFrame: { url: 'https://evil.example/x' } });

    win.close();
    await flushMicrotasks(2);
    expect(win.webContents.send).not.toHaveBeenCalledWith('layout:flush-request', expect.anything());
    expect(win.destroyed).toBe(true);
  });
});

describe('window close layout flush', () => {
  it('T14a: close prevents default, sends flush request, and waits for ack', async () => {
    const win = createMockMainWindow(5);

    win.close();

    expect(win.webContents.send).toHaveBeenCalledWith('layout:flush-request', {
      windowId: win.id,
      requestId: expect.any(Number),
    });
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(win.destroyed).toBe(false);

    ack(win);
    await flushMicrotasks(2);

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
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(win.destroyed).toBe(false);

    ack(win); // 单个 ack 即可结算(未被第二次覆盖)
    await flushMicrotasks(2);
    expect(win.destroyed).toBe(true);
    await waitForLastClosedAt(7);
  });

  it('T14b: ack completes once and later timer cannot close twice', async () => {
    vi.useFakeTimers();
    const win = createMockMainWindow(5);

    win.close();
    ack(win);
    ack(win);
    await flushMicrotasks(2);
    await vi.advanceTimersByTimeAsync(1000);

    expect(win.destroyed).toBe(true);
    expect(win.close).toHaveBeenCalledTimes(2);
    await waitForLastClosedAt(5);
  });

  it('T14c: timeout fallback closes when ack never arrives', async () => {
    vi.useFakeTimers();
    const win = createMockMainWindow(5);

    win.close();
    // 数据安全(复查 P1):放宽超时前不应关窗 —— 慢盘合法 flush 不被 1s 切断。
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks(2);
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(win.destroyed).toBe(false); // 1s 时仍在等 ack(旧值会在此误关)

    await vi.advanceTimersByTimeAsync(FLUSH_ACK_TIMEOUT_MS);
    await flushMicrotasks(2);
    expect(win.destroyed).toBe(true); // 兜底超时仍会关(防挂死)
    expect(win.close).toHaveBeenCalledTimes(2);
    await waitForLastClosedAt(5);
  });

  it('T14f: webContents 已销毁 → flush 立即放行(不空等满超时)', async () => {
    vi.useFakeTimers();
    const win = createMockMainWindow(5);
    win.destroyed = true; // renderer 已不可交互

    win.close();
    await flushMicrotasks(2);

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
      ackBody(win), // requestId 正确:只因 sender 不是该窗口而被拒
    );
    await flushMicrotasks(2);
    expect(win.destroyed).toBe(false);

    await vi.advanceTimersByTimeAsync(FLUSH_ACK_TIMEOUT_MS);
    await flushMicrotasks(2);
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
      ackBody(win), // requestId 正确:只因 frame 不受信而被拒
    );
    await flushMicrotasks(2);
    expect(win.destroyed).toBe(false);

    await vi.advanceTimersByTimeAsync(FLUSH_ACK_TIMEOUT_MS);
    await flushMicrotasks(2);
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

  it('T20c: 关窗时窗口段超过上限 → 摘最旧 closed 段;活跃窗、主窗段(seq 0)与刚关的窗口保留', async () => {
    const sortDefault = { by: 'name' as const, reverse: false };
    const payload = defaultExplorerV3();
    payload.windows = [
      { ...payload.windows[0]!, lastClosedAt: 1 },
      ...Array.from({ length: 120 }, (_, i) => ({
        windowSeq: i + 100,
        workspace: { root: `/w${i}` },
        explorer: { activePath: null, expandedPaths: [], sort: sortDefault },
        lastClosedAt: 1000 + i,
      })),
    ];
    await fs.writeFile(path.join(dir, 'explorer.json'), JSON.stringify(payload));
    const active = createMockMainWindow(100); // 段最旧但窗口活跃
    const closing = createMockMainWindow(300);

    closing.close();
    ack(closing);
    await vi.waitFor(async () => {
      const after = await loadExplorer(path.join(dir, 'explorer.json'));
      expect(after?.windows).toHaveLength(MAX_PERSISTED_WINDOW_SEGMENTS);
    });
    const seqs = (await loadExplorer(path.join(dir, 'explorer.json')))!.windows.map(
      (w) => w.windowSeq,
    );
    expect(seqs).toContain(0);
    expect(seqs).toContain(100);
    expect(seqs).toContain(300);
    expect(seqs).toContain(219); // 最新的 closed 段
    expect(seqs).not.toContain(101); // 最旧的非活跃 closed 段
    expect(active.destroyed).toBe(false);
  });

  it('T20e: 关窗 LRU 不摘缺 lastClosedAt 的段(上次会话仍开着),摘有时间戳的最旧段', async () => {
    const sortDefault = { by: 'name' as const, reverse: false };
    const payload = defaultExplorerV3();
    payload.windows = [
      { ...payload.windows[0]!, lastClosedAt: 1 },
      ...Array.from({ length: 120 }, (_, i) => ({
        windowSeq: i + 100,
        workspace: { root: `/w${i}` },
        explorer: { activePath: null, expandedPaths: [], sort: sortDefault },
        ...(i < 2 ? {} : { lastClosedAt: 1000 + i }), // seq 100/101 无时间戳
      })),
    ];
    await fs.writeFile(path.join(dir, 'explorer.json'), JSON.stringify(payload));
    const closing = createMockMainWindow(300);

    closing.close();
    ack(closing);
    await vi.waitFor(async () => {
      const after = await loadExplorer(path.join(dir, 'explorer.json'));
      expect(after?.windows).toHaveLength(MAX_PERSISTED_WINDOW_SEGMENTS);
    });
    const seqs = (await loadExplorer(path.join(dir, 'explorer.json')))!.windows.map(
      (w) => w.windowSeq,
    );
    expect(seqs).toContain(100);
    expect(seqs).toContain(101);
    expect(seqs).toContain(300);
    expect(seqs).not.toContain(102); // 有时间戳的最旧段
    // 跨启动老化:缺时间戳的陈旧段随本次关窗写盘补上固定时间戳,下次启动不再被重算为「最新」。
    const after = (await loadExplorer(path.join(dir, 'explorer.json')))!.windows;
    expect(after.find((w) => w.windowSeq === 100)?.lastClosedAt).toEqual(expect.any(Number));
    expect(after.find((w) => w.windowSeq === 101)?.lastClosedAt).toEqual(expect.any(Number));
  });

  it('T20f: 启动恢复阶段未结束时关窗 → 不给缺时间戳的段补写(它们可能即将被恢复并开着);自身段照写', async () => {
    const { isStartupRestoreInFlight } = await import(
      '../../../electron/main/services/window-restore.service'
    );
    vi.mocked(isStartupRestoreInFlight).mockReturnValue(true);
    try {
      const sortDefault = { by: 'name' as const, reverse: false };
      const payload = defaultExplorerV3();
      payload.windows = [
        payload.windows[0]!,
        {
          windowSeq: 100,
          workspace: { root: '/w100' },
          explorer: { activePath: null, expandedPaths: [], sort: sortDefault },
        },
      ];
      await fs.writeFile(path.join(dir, 'explorer.json'), JSON.stringify(payload));
      const closing = createMockMainWindow(300);

      closing.close();
      ack(closing);
      await waitForLastClosedAt(300);

      const after = (await loadExplorer(path.join(dir, 'explorer.json')))!.windows;
      expect(after.find((w) => w.windowSeq === 100)?.lastClosedAt).toBeUndefined();
    } finally {
      vi.mocked(isStartupRestoreInFlight).mockReturnValue(false);
    }
  });

  it('T20d: 两窗近同时关闭 → 先落盘的 LRU 不摘另一个仍在关闭中(尚未写 lastClosedAt)的窗口段', async () => {
    const sortDefault = { by: 'name' as const, reverse: false };
    const payload = defaultExplorerV3();
    payload.windows = [
      { ...payload.windows[0]!, lastClosedAt: 1 },
      ...Array.from({ length: 120 }, (_, i) => ({
        windowSeq: i + 100,
        workspace: { root: `/w${i}` },
        explorer: { activePath: null, expandedPaths: [], sort: sortDefault },
        lastClosedAt: 1000 + i,
      })),
    ];
    await fs.writeFile(path.join(dir, 'explorer.json'), JSON.stringify(payload));
    const first = createMockMainWindow(300);
    const second = createMockMainWindow(100); // 段最旧,且与 first 同时关闭

    first.close();
    second.close();
    ack(first);
    ack(second);
    await vi.waitFor(async () => {
      const after = await loadExplorer(path.join(dir, 'explorer.json'));
      const seg = after?.windows.find((w) => w.windowSeq === 100);
      expect(seg?.lastClosedAt).toBeGreaterThan(1000);
    });
    const after = (await loadExplorer(path.join(dir, 'explorer.json')))!;
    const seg100 = after.windows.find((w) => w.windowSeq === 100)!;
    expect(seg100.workspace).toEqual({ root: '/w0' });
    expect(after.windows.map((w) => w.windowSeq)).toContain(300);
    expect(after.windows).toHaveLength(MAX_PERSISTED_WINDOW_SEGMENTS);
  });

  it('before-quit 扫描窗口不对 getAllWindows 结果 filter 出中间数组,且仍 flush 存活窗口', async () => {
    const a = createMockMainWindow(11);
    const b = createMockMainWindow(12);
    const dead = createMockMainWindow(13);
    dead.destroyed = true;
    const filterSpy = vi.spyOn(electronMock.windows, 'filter');
    const handler = electronMock.appHandlers.get('before-quit')?.[0];
    if (!handler) throw new Error('before-quit handler missing');
    const event = { preventDefault: vi.fn() };

    try {
      const done = handler(event);

      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(filterSpy).not.toHaveBeenCalled();
      expect(a.webContents.send).toHaveBeenCalledWith('layout:flush-request', {
        windowId: a.id,
        requestId: expect.any(Number),
      });
      expect(b.webContents.send).toHaveBeenCalledWith('layout:flush-request', {
        windowId: b.id,
        requestId: expect.any(Number),
      });
      expect(dead.webContents.send).not.toHaveBeenCalledWith(
        'layout:flush-request',
        expect.anything(),
      );

      ack(a);
      ack(b);
      await done;
    } finally {
      filterSpy.mockRestore();
    }
  });
});
