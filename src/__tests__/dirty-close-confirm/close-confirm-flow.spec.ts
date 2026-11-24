// 关窗 / 退出时脏文件确认:main 侧端到端握手(electron 全 mock,驱动 createMainWindow 与
// before-quit)。mock 骨架照抄 dock-layout-per-window-seq/close-flush.spec.ts。见同目录 README.md。
//
// 注意:quitGuard / flushedOnQuit 是 main 模块级单例,本文件内 before-quit 用例按
// 「取消 → 保存失败 → 成功退出」顺序排列,成功退出后守卫进入 finished,必须放在最后。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _reset as resetWindowSeq } from '../../../electron/main/services/window-seq.service';
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
      reload: vi.fn(),
      reloadIgnoringCache: vi.fn(),
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
    readonly show = vi.fn();
    readonly setDocumentEdited = vi.fn();
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
    showMessageBox: vi.fn(async (_win: unknown, _opts: unknown) => ({ response: 2 })),
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
  dialog: {
    showOpenDialog: vi.fn(),
    showMessageBox: electronMock.showMessageBox,
  },
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
// 退出清理接线:插件 shell 子进程(exec / stream)的 cleanupAll 须纳入 before-quit 的 awaited 清理。
vi.mock('../../../electron/main/services/shell.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/main/services/shell.service')>()),
  cleanupAllShellExecs: vi.fn(async () => undefined),
}));
vi.mock('../../../electron/main/services/plugin-shell-stream.service', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../electron/main/services/plugin-shell-stream.service')
  >()),
  cleanupAllShellStreams: vi.fn(async () => undefined),
}));

const { app } = await import('electron');
const termService = await import('../../../electron/main/services/terminal.service');
const shellService = await import('../../../electron/main/services/shell.service');
const shellStream = await import('../../../electron/main/services/plugin-shell-stream.service');
const agentAuth = await import('../../../electron/main/services/agent-auth.service');
const { createMainWindow, buildAppMenu, FLUSH_ACK_TIMEOUT_MS } = await import(
  '../../../electron/main/index'
);

type MockWin = InstanceType<typeof electronMock.MockBrowserWindow>;

const TRUSTED = { url: 'file:///renderer/index.html' };

function handlerOf(channel: string): Listener {
  const h = electronMock.ipcHandlers.get(channel)?.[0];
  if (!h) throw new Error(`missing ${channel} handler`);
  return h;
}

function createReadyWindow(windowSeq: number): MockWin {
  const win = createMainWindow({ windowSeq }) as unknown as MockWin;
  handlerOf('layout:flush-ready')({ sender: win.webContents, senderFrame: TRUSTED });
  return win;
}

function reportDirty(
  win: MockWin,
  state: unknown,
  opts: { frame?: { url: string }; sender?: MockWin } = {},
): void {
  handlerOf('layout:dirty-state')(
    { sender: (opts.sender ?? win).webContents, senderFrame: opts.frame ?? TRUSTED },
    state,
  );
}

/** renderer 的回执:原样带回 requestId(未显式给出时取该窗口最近一次 flush 请求的)。 */
function ack(win: MockWin, result?: Record<string, unknown>): void {
  const requests = flushRequests(win) as { requestId?: unknown }[];
  const latest = requests[requests.length - 1]?.requestId;
  const payload =
    result && 'requestId' in result ? result : { ...result, ...(latest === undefined ? {} : { requestId: latest }) };
  handlerOf('layout:flush-ack')({ sender: win.webContents, senderFrame: TRUSTED }, win.id, payload);
}

function flushRequests(win: MockWin): unknown[] {
  return win.webContents.send.mock.calls
    .filter((c) => c[0] === 'layout:flush-request')
    .map((c) => c[1]);
}

/** 第 index 个 flush 请求的 requestId(main 要求回执原样带回)。 */
function requestIdOf(win: MockWin, index: number): number {
  const req = flushRequests(win)[index] as { requestId?: unknown } | undefined;
  if (typeof req?.requestId !== 'number') throw new Error(`missing requestId #${index}`);
  return req.requestId;
}

/** 合法脏态上报(计数由 id 列表推出;main 按 id 身份比较已接受范围)。 */
function ds(ids: string[], untitledIds: string[] = []) {
  return { dirty: ids.length, untitled: untitledIds.length, ids, untitledIds };
}

/** 让 dialog / flush 的 promise 链跑完。 */

let dir: string;

beforeEach(async () => {
  vi.useRealTimers();
  electronMock.reset();
  resetWindowSeq();
  electronMock.showMessageBox.mockReset();
  dir = await fs.mkdtemp(path.join(tmpdir(), 'continuo-dirty-close-'));
  electronMock.userData = dir;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  resetWindowSeq();
  // closed 后的 lastClosedAt 异步写盘可能仍在落地:等一下并让 rm 对 ENOTEMPTY 重试,避免与删目录竞态。
  await new Promise((r) => setTimeout(r, 20));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe('关窗:无脏文件时行为不变', () => {
  it('从未上报脏态 / 脏数回到 0 → 不弹框,立即 hide 并发 flush(不带 save)', async () => {
    const win = createReadyWindow(1);
    reportDirty(win, ds(['/w/a.ts', '/w/b.ts']));
    reportDirty(win, ds([]));

    win.close();

    expect(electronMock.showMessageBox).not.toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(flushRequests(win)).toEqual([{ windowId: win.id, requestId: expect.any(Number) }]);
    ack(win);
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(true);
  });

  it('不受信 frame / 别的窗口发来的脏态上报被忽略', async () => {
    const win = createReadyWindow(2);
    const other = createReadyWindow(3);
    reportDirty(win, ds(['/w/a.ts']), { frame: { url: 'https://evil.example/' } });
    reportDirty(win, ds(['/w/a.ts']), { sender: other });

    win.close();
    expect(electronMock.showMessageBox).not.toHaveBeenCalled();
    ack(win);
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(true);
  });
});

describe('关窗:有脏文件时先确认', () => {
  it('弹框挂在该窗口上;回答前不 hide、不 flush', async () => {
    const win = createReadyWindow(4);
    reportDirty(win, ds(['/w/a.ts', '/w/b.ts']));
    electronMock.showMessageBox.mockReturnValueOnce(new Promise(() => undefined));

    win.close();
    await flushMicrotasks(10);

    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(1);
    expect(electronMock.showMessageBox.mock.calls[0]?.[0]).toBe(win);
    expect(win.hide).not.toHaveBeenCalled();
    expect(flushRequests(win)).toEqual([]);
    expect(win.destroyed).toBe(false);
  });

  it('取消 → 窗口保持打开;再次关闭会再次确认', async () => {
    const win = createReadyWindow(5);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 2 });

    win.close();
    await flushMicrotasks(10);
    expect(win.hide).not.toHaveBeenCalled();
    expect(flushRequests(win)).toEqual([]);
    expect(win.destroyed).toBe(false);

    electronMock.showMessageBox.mockResolvedValueOnce({ response: 2 });
    win.close();
    await flushMicrotasks(10);
    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(2);
    expect(win.destroyed).toBe(false);
  });

  it('确认框打开期间重复关闭不叠加第二个确认框', async () => {
    const win = createReadyWindow(6);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockReturnValueOnce(new Promise(() => undefined));

    win.close();
    win.close();
    await flushMicrotasks(10);
    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('不保存 → hide + flush(带 discard:true,renderer 跳过最终脏检查),ack 后关闭', async () => {
    const win = createReadyWindow(7);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 1 });

    win.close();
    await flushMicrotasks(10);
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(flushRequests(win)).toEqual([
      { windowId: win.id, discard: true, requestId: expect.any(Number) },
    ]);

    ack(win);
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(true);
  });

  it('保存且成功 → flush(save:true),ack 后关闭', async () => {
    const win = createReadyWindow(8);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 });

    win.close();
    await flushMicrotasks(10);
    expect(flushRequests(win)).toEqual([{ windowId: win.id, save: true, requestId: expect.any(Number) }]);

    ack(win, { saveFailed: false });
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(true);
  });

  it('保存失败 → 中止关闭、窗口重新显示;之后可再次关闭', async () => {
    const win = createReadyWindow(9);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 });

    win.close();
    await flushMicrotasks(10);
    ack(win, { saveFailed: true });
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(false);
    expect(win.show).toHaveBeenCalledTimes(1);

    // 用户改选「不保存」→ 正常关闭
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 1 });
    win.close();
    await flushMicrotasks(10);
    ack(win);
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(true);
  });

  it('保存后 renderer 迟迟不回执(超时)→ 视为保存未确认,不关闭', async () => {
    vi.useFakeTimers();
    const win = createReadyWindow(10);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 });

    win.close();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(FLUSH_ACK_TIMEOUT_MS);
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(false);
    expect(win.show).toHaveBeenCalledTimes(1);
  });
});

describe('关窗「保存」:flush 被跳过也视为保存未确认', () => {
  // 复审:save:true 的 flush 若 skipped(renderer 未就绪 / send 抛错)此前被当成功关闭 → 未保存就关窗。
  it('renderer 未上报 flush-ready → 不关闭,窗口重新显示', async () => {
    const win = createMainWindow({ windowSeq: 30 }) as unknown as MockWin;
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 });

    win.close();
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(false);
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('发送 flush 请求抛错 → 不关闭,窗口重新显示', async () => {
    const win = createReadyWindow(31);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 });
    win.webContents.send.mockImplementation(() => {
      throw new Error('render frame disposed');
    });

    win.close();
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(false);
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('「不保存」时 skipped 仍照常关闭(行为不变)', async () => {
    const win = createMainWindow({ windowSeq: 32 }) as unknown as MockWin;
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 1 });

    win.close();
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(true);
  });
});

describe('flush 回执按 requestId 匹配', () => {
  it('requestId 不匹配 / 缺失的回执被忽略;匹配的才结算', async () => {
    const win = createReadyWindow(33);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 });

    win.close();
    await flushMicrotasks(10);
    const id = requestIdOf(win, 0);
    ack(win, { saveFailed: false, requestId: id + 1000 });
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(false);

    // 不带 requestId 的回执同样不结算(即便该窗口只有一个在途请求)
    ack(win, { saveFailed: false, requestId: undefined });
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(false);

    ack(win, { saveFailed: false, requestId: id });
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(true);
  });
});

// 统一规则:renderer 全部 flush 完成后做最终脏检查,仍有未保存改动(且本轮未选「不保存」)→ 回执 remaining。
// main 收到即中止关闭、窗口重新显示,并用 remaining 记账 → 再次关闭会弹确认。
describe('关窗:flush 后最终脏检查仍有未保存改动 → 中止关闭', () => {
  it('(a) 无确认框的关窗,flush 回执 remaining → 不关闭、重新显示;再次关闭弹确认', async () => {
    const win = createReadyWindow(40);
    // 脏 .md 在防抖内:renderer 计数排除 → main 无脏记账、不弹框。
    win.close();
    expect(electronMock.showMessageBox).not.toHaveBeenCalled();
    ack(win, { requestId: requestIdOf(win, 0), remaining: ds(['/w/a.ts']) });
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(false);
    expect(win.show).toHaveBeenCalledTimes(1);

    electronMock.showMessageBox.mockResolvedValueOnce({ response: 2 });
    win.close();
    await flushMicrotasks(10);
    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(1);
    expect(win.destroyed).toBe(false);
  });

  it('选「保存」且保存成功,但回执 remaining(flush 期间继续输入)→ 不关闭', async () => {
    const win = createReadyWindow(41);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 });

    win.close();
    await flushMicrotasks(10);
    ack(win, { saveFailed: false, requestId: requestIdOf(win, 0), remaining: ds(['/w/a.ts']) });
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(false);
    expect(win.show).toHaveBeenCalledTimes(1);
  });
});

// 终审 P1:活动 tab 的脏 .md 在 autosave 开启时不计入确认(交给关窗 flush 落盘),renderer 另报 pendingAutoSave。
// 读盘挂起的网络卷(SMB/SSHFS/FUSE)上 flush 超过 FLUSH_ACK_TIMEOUT_MS → 未弹框的关闭不能因超时放行(会丢编辑)。
// 但 pendingAutoSave 为空时超时仍照常放行:renderer 卡死 / 崩溃永不回执时窗口必须能关。
describe('关窗:未弹框的 flush 超时,按 pendingAutoSave 决定是否放行', () => {
  it('pendingAutoSave 非空 + 超时 → 不关闭、重新显示;守卫已释放,可再次关闭', async () => {
    vi.useFakeTimers();
    const win = createReadyWindow(60);
    reportDirty(win, { ...ds([]), pendingAutoSave: ['/w/a.md#1'] });

    win.close();
    expect(electronMock.showMessageBox).not.toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FLUSH_ACK_TIMEOUT_MS);
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(false);
    expect(win.show).toHaveBeenCalledTimes(1);

    win.close();
    expect(flushRequests(win)).toHaveLength(2);
    ack(win, { requestId: requestIdOf(win, 1), state: ds([]) });
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(true);
  });

  // 「不保存」只针对确认框列出的文件;活动 tab 的待 autosave .md 不在列表里(用户未被告知会丢),
  // flush 超时同样不能放行。
  it('选「不保存」+ pendingAutoSave 非空 + 超时 → 不关闭、重新显示', async () => {
    vi.useFakeTimers();
    const win = createReadyWindow(63);
    reportDirty(win, { ...ds(['/w/x.ts#1']), pendingAutoSave: ['/w/a.md#1'] });
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 1 });

    win.close();
    await flushMicrotasks(10);
    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FLUSH_ACK_TIMEOUT_MS);
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(false);
    expect(win.show).toHaveBeenCalled();
  });

  // 终审 P1:「不保存」时待 autosave 的 .md 在 flush 中首次保存失败 → renderer 回执 remaining,main 同样中止。
  it('选「不保存」:flush 请求带确认时的 pendingAutoSave;回执 remaining(.md 保存失败)→ 不关闭、重新显示', async () => {
    const win = createReadyWindow(64);
    reportDirty(win, { ...ds(['/w/x.ts#1']), pendingAutoSave: ['/w/a.md#1'] });
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 1 });

    win.close();
    await flushMicrotasks(10);
    expect(flushRequests(win)).toEqual([
      {
        windowId: win.id,
        discard: true,
        pendingAutoSave: ['/w/a.md#1'],
        requestId: expect.any(Number),
      },
    ]);
    ack(win, {
      requestId: requestIdOf(win, 0),
      state: ds(['/w/a.md#1', '/w/x.ts#1']),
      remaining: ds(['/w/a.md#1', '/w/x.ts#1']),
    });
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(false);
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it('选「不保存」+ pendingAutoSave 的 .md 保存成功(回执无 remaining)→ 照常关闭', async () => {
    const win = createReadyWindow(65);
    reportDirty(win, { ...ds(['/w/x.ts#1']), pendingAutoSave: ['/w/a.md#1'] });
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 1 });

    win.close();
    await flushMicrotasks(10);
    ack(win, { requestId: requestIdOf(win, 0), state: ds(['/w/x.ts#1']) });
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(true);
  });

  it('pendingAutoSave 为空(从未上报 / 已清空)+ 超时 → 照常关闭', async () => {
    vi.useFakeTimers();
    const never = createReadyWindow(61);
    const cleared = createReadyWindow(62);
    reportDirty(cleared, { ...ds([]), pendingAutoSave: ['/w/a.md#1'] });
    reportDirty(cleared, ds([]));

    never.close();
    cleared.close();
    await vi.advanceTimersByTimeAsync(FLUSH_ACK_TIMEOUT_MS);
    await flushMicrotasks(10);
    expect(never.destroyed).toBe(true);
    expect(cleared.destroyed).toBe(true);
  });
});

interface ReloadMenuItem {
  readonly accelerator?: string;
  readonly role?: string;
  readonly submenu?: readonly ReloadMenuItem[];
  readonly click?: (item: unknown, win: unknown, event: unknown) => void;
}

/** 应用菜单里 View 子菜单(Menu.buildFromTemplate 被 mock 成原样返回模板)。 */
function viewSubmenu(): readonly ReloadMenuItem[] {
  const template = buildAppMenu(((key: string) => key) as never) as unknown as ReloadMenuItem[];
  const view = template.find((m) => m.role === 'viewMenu');
  if (!view?.submenu) throw new Error('missing view submenu');
  return view.submenu;
}

/** 以菜单方式(含其快捷键)对 win 触发 Reload / Force Reload。 */
function menuReload(win: MockWin, force = false): void {
  const accelerator = force ? 'Shift+CmdOrCtrl+R' : 'CmdOrCtrl+R';
  const item = viewSubmenu().find((m) => m.accelerator === accelerator);
  if (!item?.click) throw new Error(`missing reload item ${accelerator}`);
  item.click(item, win, {});
}

describe('主窗 Reload / Force Reload:与关窗同一的脏确认 + flush', () => {
  it('View 菜单保留其余默认项(DevTools / 缩放 / 全屏)', () => {
    const roles = viewSubmenu().map((m) => m.role).filter(Boolean);
    expect(roles).toEqual(['toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']);
  });

  it('有脏 tab → 先弹确认框(挂在该窗口上),回答前不 reload、不 flush、不隐藏窗口', async () => {
    const win = createReadyWindow(41);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockReturnValueOnce(new Promise(() => undefined));

    menuReload(win);
    menuReload(win); // 确认框打开期间重复触发不叠框
    await flushMicrotasks(10);

    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(1);
    expect(electronMock.showMessageBox.mock.calls[0]?.[0]).toBe(win);
    expect(flushRequests(win)).toEqual([]);
    expect(win.webContents.reload).not.toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
  });

  it('确认框打开期间窗口被销毁 → 不 flush、不 reload、不抛错', async () => {
    const win = createReadyWindow(48);
    reportDirty(win, ds(['/w/a.ts']));
    let answer!: (v: { response: number }) => void;
    electronMock.showMessageBox.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown): void => {
      unhandled.push(r);
    };
    process.on('unhandledRejection', onUnhandled);
    const wc = win.webContents;
    menuReload(win);
    await flushMicrotasks(5);
    // 真实 Electron:已销毁窗口的 webContents getter 抛 "Object has been destroyed"。
    win.destroyed = true;
    Object.defineProperty(win, 'webContents', {
      get() {
        throw new Error('Object has been destroyed');
      },
    });
    answer({ response: 0 });
    await flushMicrotasks(10);
    await new Promise((r) => setTimeout(r, 0));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
    expect(wc.reload).not.toHaveBeenCalled();
  });

  it('取消 → 不 flush、不 reload;之后再刷新会再次确认', async () => {
    const win = createReadyWindow(42);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 2 });

    menuReload(win);
    await flushMicrotasks(10);
    expect(flushRequests(win)).toEqual([]);
    expect(win.webContents.reload).not.toHaveBeenCalled();

    electronMock.showMessageBox.mockResolvedValueOnce({ response: 2 });
    menuReload(win);
    await flushMicrotasks(10);
    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(2);
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it('保存 → 先 flush(save:true),ack 之后才 reload', async () => {
    const win = createReadyWindow(43);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 });

    menuReload(win);
    await flushMicrotasks(10);
    expect(flushRequests(win)).toEqual([
      { windowId: win.id, save: true, requestId: expect.any(Number) },
    ]);
    expect(win.webContents.reload).not.toHaveBeenCalled();

    ack(win);
    await flushMicrotasks(10);
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    expect(win.destroyed).toBe(false);
  });

  it('保存失败 → 不 reload', async () => {
    const win = createReadyWindow(44);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 });

    menuReload(win);
    await flushMicrotasks(10);
    ack(win, { saveFailed: true });
    await flushMicrotasks(10);
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it('不保存 → flush(discard:true)后 reload', async () => {
    const win = createReadyWindow(45);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 1 });

    menuReload(win, true);
    await flushMicrotasks(10);
    expect(flushRequests(win)).toEqual([
      { windowId: win.id, discard: true, requestId: expect.any(Number) },
    ]);
    ack(win);
    await flushMicrotasks(10);
    expect(win.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it('无脏 tab → 不弹框,flush(落盘布局与待 autosave 的 .md)后 reload', async () => {
    const win = createReadyWindow(46);

    menuReload(win);
    await flushMicrotasks(10);
    expect(electronMock.showMessageBox).not.toHaveBeenCalled();
    expect(flushRequests(win)).toEqual([{ windowId: win.id, requestId: expect.any(Number) }]);
    ack(win);
    await flushMicrotasks(10);
    expect(win.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it('无脏 tab 但 flush 后仍有未保存改动(.md autosave 失败)→ 不 reload', async () => {
    const win = createReadyWindow(47);

    menuReload(win);
    await flushMicrotasks(10);
    ack(win, { remaining: ds(['/w/a.md']) });
    await flushMicrotasks(10);
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it('popout 子窗:菜单 Reload 不生效(维持屏蔽刷新)', async () => {
    const win = createReadyWindow(48);
    win.webContents.getURL.mockReturnValue('file:///renderer/index.html?popout=1');
    reportDirty(win, ds(['/w/a.ts']));

    menuReload(win);
    menuReload(win, true);
    await flushMicrotasks(10);
    expect(electronMock.showMessageBox).not.toHaveBeenCalled();
    expect(flushRequests(win)).toEqual([]);
    expect(win.webContents.reload).not.toHaveBeenCalled();
    expect(win.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
  });
});

describe('退出应用(before-quit):对每个有脏文件的主窗确认', () => {
  function beforeQuit(): { event: { preventDefault: ReturnType<typeof vi.fn> }; done: unknown } {
    const handler = electronMock.appHandlers.get('before-quit')?.[0];
    if (!handler) throw new Error('missing before-quit handler');
    const event = { preventDefault: vi.fn() };
    const done = handler(event);
    return { event, done };
  }

  it('任一窗口取消 → 中止整个退出,不 flush;再次 Cmd+Q 能再次确认', async () => {
    const a = createReadyWindow(20);
    const b = createReadyWindow(21);
    reportDirty(a, ds(['/w/a.ts']));
    reportDirty(b, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 2 });

    const { event, done } = beforeQuit();
    await done;
    expect(event.preventDefault).toHaveBeenCalled();
    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(1); // a 取消后不再问 b
    expect(flushRequests(a)).toEqual([]);
    expect(flushRequests(b)).toEqual([]);
    expect(app.quit).not.toHaveBeenCalled();

    // 守卫已复位:再次退出重新走确认(而非卡在「清理在途」直接 block)
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 2 });
    const second = beforeQuit();
    await second.done;
    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(2);
    expect(app.quit).not.toHaveBeenCalled();
    a.destroyed = true;
    b.destroyed = true;
  });

  // 终审 P1:A 选「不保存」后 B 的确认框仍打开时,用户回到 A 继续编辑同一已脏文件 —— 身份不变(dirtyGen 只在
  // clean→dirty 递增)被全局最终检查视为已接受 → 新增内容静默丢失。冻结方案:回答确认框后立即隐藏该窗口直到退出完成;
  // 退出中止时恢复显示。
  it('多窗退出:A 回答「不保存」后立即隐藏;B 取消 → 退出中止,A 重新显示', async () => {
    const a = createReadyWindow(27);
    const b = createReadyWindow(28);
    reportDirty(a, ds(['/w/a.ts']));
    reportDirty(b, ds(['/w/b.ts']));
    let answerB!: (r: { response: number }) => void;
    electronMock.showMessageBox
      .mockResolvedValueOnce({ response: 1 }) // A:不保存
      .mockImplementationOnce(() => new Promise((r) => (answerB = r))); // B:挂起

    const { done } = beforeQuit();
    await flushMicrotasks(10);
    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(2); // B 的确认框已打开
    expect(a.hide).toHaveBeenCalled();
    expect(b.hide).not.toHaveBeenCalled();
    expect(a.show).not.toHaveBeenCalled();

    answerB({ response: 2 }); // B:取消
    await done;
    expect(a.show).toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    a.destroyed = true;
    b.destroyed = true;
  });

  it('保存失败 → 中止退出、显示该窗口;守卫复位', async () => {
    const a = createReadyWindow(22);
    reportDirty(a, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 });

    const { done } = beforeQuit();
    await flushMicrotasks(10);
    expect(flushRequests(a)).toEqual([{ windowId: a.id, save: true, requestId: expect.any(Number) }]);
    ack(a, { saveFailed: true });
    await done;
    expect(a.show).toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();

    // 守卫复位:再次退出会再次确认
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 2 });
    await beforeQuit().done;
    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(2);
    a.destroyed = true;
  });

  // 复审:单窗关闭(不保存)与 Cmd+Q(保存)交叉 → 两次 flush 同一 windowId。此前 pending ack 按窗口覆盖,
  // 关窗请求的 ack 唤醒退出请求(「不保存」的 ack 被当「保存」成功)→ 保存未完成就退出。
  it('关窗 flush 在途时 Cmd+Q:旧请求的回执不结算新请求', async () => {
    const win = createReadyWindow(26);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox
      .mockResolvedValueOnce({ response: 1 }) // 关窗:不保存
      .mockResolvedValueOnce({ response: 0 }); // 退出:保存

    win.close();
    await flushMicrotasks(10);
    const { done } = beforeQuit();
    await flushMicrotasks(10);
    expect(flushRequests(win)).toEqual([
      { windowId: win.id, discard: true, requestId: expect.any(Number) },
      { windowId: win.id, save: true, requestId: expect.any(Number) },
    ]);
    const closeReq = requestIdOf(win, 0);
    const quitReq = requestIdOf(win, 1);
    expect(quitReq).not.toBe(closeReq);

    ack(win, { requestId: closeReq });
    await flushMicrotasks(10);
    expect(app.quit).not.toHaveBeenCalled(); // 退出仍在等「保存」的回执
    // 复审(d):旧「不保存」关闭流程已被退出流程接管 → 其 ack 到达后不得 win.close() 销毁窗口
    // (否则「保存」尚未完成窗口就没了)。
    expect(win.destroyed).toBe(false);

    ack(win, { saveFailed: true, requestId: quitReq });
    await done;
    expect(app.quit).not.toHaveBeenCalled();
    expect(win.destroyed).toBe(false);
    expect(win.show).toHaveBeenCalled();

    // 被接管的旧流程已复位:用户再次关闭会重新确认,不卡在「flush 在途」。
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 1 });
    win.close();
    await flushMicrotasks(10);
    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(3);
    ack(win, { requestId: requestIdOf(win, 2) });
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(true);
  });

  it('「保存」的 flush 被跳过(renderer 未就绪)→ 中止退出、显示该窗口', async () => {
    const a = createMainWindow({ windowSeq: 27 }) as unknown as MockWin;
    reportDirty(a, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 });

    await beforeQuit().done;
    expect(a.show).toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    a.destroyed = true;
  });

  it('(b) Cmd+Q 选「保存」,保存成功但慢 flush 期间继续输入(回执 remaining)→ 中止退出、守卫复位', async () => {
    const a = createReadyWindow(42);
    reportDirty(a, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 });

    const { done } = beforeQuit();
    await flushMicrotasks(10);
    ack(a, { saveFailed: false, requestId: requestIdOf(a, 0), remaining: ds(['/w/a.ts']) });
    await done;
    expect(app.quit).not.toHaveBeenCalled();
    expect(a.show).toHaveBeenCalled();

    electronMock.showMessageBox.mockResolvedValueOnce({ response: 2 });
    await beforeQuit().done;
    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(2);
    a.destroyed = true;
  });

  it('(c) 多窗退出:B 确认期间干净的 A 变脏 → A 的非保存 flush 回执 remaining → 中止退出', async () => {
    const a = createReadyWindow(43);
    const b = createReadyWindow(44);
    reportDirty(b, ds(['/w/a.ts']));
    let answerB: (v: { response: number }) => void = () => undefined;
    electronMock.showMessageBox.mockReturnValueOnce(
      new Promise((r) => {
        answerB = r;
      }),
    );

    const { done } = beforeQuit();
    await flushMicrotasks(10);
    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(1); // A 干净不弹框,只问 B
    answerB({ response: 1 }); // B:不保存
    await flushMicrotasks(10);
    expect(flushRequests(a)).toEqual([{ windowId: a.id, requestId: expect.any(Number) }]);
    ack(a, { requestId: requestIdOf(a, 0), remaining: ds(['/w/a.ts']) });
    ack(b, { requestId: requestIdOf(b, 0) });
    await done;
    expect(app.quit).not.toHaveBeenCalled();
    expect(a.show).toHaveBeenCalled();

    // 守卫复位 + A 已记账:再次 Cmd+Q 会对 A 弹确认
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 2 });
    await beforeQuit().done;
    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(2);
    expect(electronMock.showMessageBox.mock.calls[1]?.[0]).toBe(a);
    a.destroyed = true;
    b.destroyed = true;
  });

  // 复审:多窗 Cmd+Q 时 A 已 flush+ACK、等待 B 保存期间,用户在仍可操作的 A 里继续编辑 → A 不再被检查,
  // app.quit() 丢改动。所有窗口 flush 完成后、破坏性清理(cleanupAll 杀 PTY)前,按 main 持续接收的脏态上报
  // 做全局最终检查:超出本轮用户已接受的范围 → 中止退出、显示该窗口、守卫复位。
  it('多窗退出:A 已 ACK 后、等待 B 保存期间 A 变脏 → 中止退出(不清理 PTY)', async () => {
    const a = createReadyWindow(45);
    const b = createReadyWindow(46);
    reportDirty(b, ds(['/w/a.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 }); // B:保存

    const { done } = beforeQuit();
    await flushMicrotasks(10);
    ack(a, { requestId: requestIdOf(a, 0) }); // A 干净,flush 完成
    await flushMicrotasks(10);
    reportDirty(a, ds(['/w/a.ts'])); // A 在等待 B 期间被编辑
    ack(b, { saveFailed: false, requestId: requestIdOf(b, 0) });
    await done;
    expect(app.quit).not.toHaveBeenCalled();
    expect(termService.cleanupAll).not.toHaveBeenCalled();
    expect(a.show).toHaveBeenCalled();
    // 最终检查失败(中止)路径不进退出屏障:未回答确认框的 A 不被隐藏;B 回答「保存」后被冻结隐藏,中止时恢复显示
    expect(a.hide).not.toHaveBeenCalled();
    expect(b.show).toHaveBeenCalled();

    // 守卫复位:再次 Cmd+Q 会对 A 弹确认
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 2 });
    await beforeQuit().done;
    expect(electronMock.showMessageBox.mock.calls[1]?.[0]).toBe(a);
    a.destroyed = true;
    b.destroyed = true;
  });

  it('多窗退出:「不保存」的窗口在等待期间新增脏 tab(超出确认时的数)→ 中止退出', async () => {
    const a = createReadyWindow(47);
    const b = createReadyWindow(48);
    reportDirty(a, ds(['/w/a.ts']));
    reportDirty(b, ds(['/w/a.ts']));
    electronMock.showMessageBox
      .mockResolvedValueOnce({ response: 1 }) // A:不保存
      .mockResolvedValueOnce({ response: 0 }); // B:保存

    const { done } = beforeQuit();
    await flushMicrotasks(10);
    ack(a, { requestId: requestIdOf(a, 0) });
    await flushMicrotasks(10);
    reportDirty(a, ds(['/w/a.ts', '/w/b.ts']));
    ack(b, { saveFailed: false, requestId: requestIdOf(b, 0) });
    await done;
    expect(app.quit).not.toHaveBeenCalled();
    expect(a.show).toHaveBeenCalled();
    a.destroyed = true;
    b.destroyed = true;
  });

  // 复审:全局最终检查此前只比数量 → 对 A 选「不保存」(当时脏 X)后保存 X、编辑 Y,计数仍 1 → 放行退出丢 Y。
  // 改按身份:当前脏 id 是本轮已接受集合的子集才放行。
  it('多窗退出:「不保存」的窗口等待期间脏集合被同数量替换(X 存了、Y 变脏)→ 中止退出', async () => {
    const a = createReadyWindow(51);
    const b = createReadyWindow(52);
    reportDirty(a, ds(['/w/x.ts']));
    reportDirty(b, ds(['/w/b.ts']));
    electronMock.showMessageBox
      .mockResolvedValueOnce({ response: 1 }) // A:不保存
      .mockResolvedValueOnce({ response: 0 }); // B:保存

    const { done } = beforeQuit();
    await flushMicrotasks(10);
    ack(a, { requestId: requestIdOf(a, 0) });
    await flushMicrotasks(10);
    reportDirty(a, ds(['/w/y.ts']));
    reportDirty(b, ds([]));
    ack(b, { saveFailed: false, requestId: requestIdOf(b, 0) });
    await done;
    expect(app.quit).not.toHaveBeenCalled();
    expect(termService.cleanupAll).not.toHaveBeenCalled();
    expect(a.show).toHaveBeenCalled();
    a.destroyed = true;
    b.destroyed = true;
  });

  it('多窗退出:「保存」的窗口等待期间 untitled 被同数量替换(新草稿)→ 中止退出', async () => {
    const a = createReadyWindow(53);
    const b = createReadyWindow(54);
    reportDirty(a, ds(['untitled-1'], ['untitled-1']));
    reportDirty(b, ds(['/w/b.ts']));
    electronMock.showMessageBox
      .mockResolvedValueOnce({ response: 0 }) // A:保存(untitled-1 已告知会丢弃)
      .mockResolvedValueOnce({ response: 0 }); // B:保存

    const { done } = beforeQuit();
    await flushMicrotasks(10);
    ack(a, { saveFailed: false, requestId: requestIdOf(a, 0) });
    await flushMicrotasks(10);
    reportDirty(a, ds(['untitled-2'], ['untitled-2']));
    reportDirty(b, ds([]));
    ack(b, { saveFailed: false, requestId: requestIdOf(b, 0) });
    await done;
    expect(app.quit).not.toHaveBeenCalled();
    expect(a.show).toHaveBeenCalled();
    a.destroyed = true;
    b.destroyed = true;
  });

  // 复审:「不保存」按 id 接受;等待期间用户保存 /x.ts 再编辑同一文件 → 只比 tab id 时仍是 /x.ts → 放行退出丢新改动。
  // renderer 上报的身份带「变脏代际」(clean→dirty 跃迁递增,形如 `${tabId}#${gen}`),再次变脏即新身份。
  it('多窗退出:「不保存」的窗口等待期间保存后再编辑同一文件(变脏代际递增)→ 中止退出', async () => {
    const a = createReadyWindow(55);
    const b = createReadyWindow(56);
    reportDirty(a, ds(['/w/x.ts#1']));
    reportDirty(b, ds(['/w/b.ts#1']));
    electronMock.showMessageBox
      .mockResolvedValueOnce({ response: 1 }) // A:不保存
      .mockResolvedValueOnce({ response: 0 }); // B:保存

    const { done } = beforeQuit();
    await flushMicrotasks(10);
    ack(a, { requestId: requestIdOf(a, 0), state: ds(['/w/x.ts#1']) });
    await flushMicrotasks(10);
    reportDirty(a, ds([])); // 保存 /x.ts
    reportDirty(a, ds(['/w/x.ts#2'])); // 再编辑同一文件
    ack(b, { saveFailed: false, requestId: requestIdOf(b, 0), state: ds([]) });
    await done;
    expect(app.quit).not.toHaveBeenCalled();
    expect(termService.cleanupAll).not.toHaveBeenCalled();
    expect(a.show).toHaveBeenCalled();
    a.destroyed = true;
    b.destroyed = true;
  });

  // 终审 P1:A 已 ACK、等待 B 保存期间在 A 的活动 .md 输入 —— 防抖未触发前该 tab 只进 pendingAutoSave(dirty 仍 0)。
  // 此前全局最终检查只看 dirty>0 → 放行退出,A 的新输入丢失。ACK 之后出现、不在本轮已接受集合中的
  // pendingAutoSave 同样视为超出接受范围。
  it('多窗退出:A 已 ACK 后、等待 B 保存期间 A 的活动 .md 新输入(仅 pendingAutoSave)→ 中止退出', async () => {
    const a = createReadyWindow(57);
    const b = createReadyWindow(58);
    reportDirty(b, ds(['/w/b.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 }); // B:保存

    const { done } = beforeQuit();
    await flushMicrotasks(10);
    ack(a, { requestId: requestIdOf(a, 0), state: ds([]) });
    await flushMicrotasks(10);
    reportDirty(a, { ...ds([]), pendingAutoSave: ['/w/a.md#2'] });
    ack(b, { saveFailed: false, requestId: requestIdOf(b, 0), state: ds([]) });
    await done;
    expect(app.quit).not.toHaveBeenCalled();
    expect(termService.cleanupAll).not.toHaveBeenCalled();
    expect(a.show).toHaveBeenCalled();
    // B 未被判为超出范围:只因回答确认框后被冻结隐藏而恢复显示一次(被判超出会再显示一次)
    expect(b.show).toHaveBeenCalledTimes(1);
    a.destroyed = true;
    b.destroyed = true;
  });

  // 兼容不带最终脏态的旧回执:ACK 不更新记账,flush 请求前已上报的 pendingAutoSave 留在 dirtyStates。
  // 这些 id 已随本轮 flush 落盘(回执无 remaining),不能误判为「ACK 之后的新输入」。
  // (用 B 的超出范围让退出中止,只断言 A 未被判为超出 —— 守卫保持可用于后续用例。)
  it('多窗退出:flush 前已上报、本轮 flush 已处理的 pendingAutoSave(旧回执不带 state)→ 不误判该窗口', async () => {
    const a = createReadyWindow(59);
    const b = createReadyWindow(60);
    reportDirty(a, { ...ds([]), pendingAutoSave: ['/w/a.md#1'] });
    reportDirty(b, ds(['/w/b.ts']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 }); // B:保存

    const { done } = beforeQuit();
    await flushMicrotasks(10);
    ack(a, { requestId: requestIdOf(a, 0) }); // 旧回执:无 state
    await flushMicrotasks(10);
    reportDirty(b, ds(['/w/b.ts', '/w/new.ts'])); // B 等待期间新增脏 tab → 超出
    ack(b, { saveFailed: false, requestId: requestIdOf(b, 0) });
    await done;
    expect(app.quit).not.toHaveBeenCalled();
    expect(b.show).toHaveBeenCalled();
    expect(a.show).not.toHaveBeenCalled();
    a.destroyed = true;
    b.destroyed = true;
  });

  // 复审:「保存」时 renderer 只能放过确认框告知用户的 untitled(按 id;此前按数量,同数量替换被放过)。
  it('「保存」的 flush 请求带上确认框告知的 untitled id', async () => {
    const a = createReadyWindow(49);
    reportDirty(a, ds(['/w/a.ts', 'untitled-1', 'untitled-2'], ['untitled-1', 'untitled-2']));
    electronMock.showMessageBox.mockResolvedValueOnce({ response: 0 });

    const { done } = beforeQuit();
    await flushMicrotasks(10);
    expect(flushRequests(a)).toEqual([
      {
        windowId: a.id,
        save: true,
        untitledIds: ['untitled-1', 'untitled-2'],
        requestId: expect.any(Number),
      },
    ]);
    ack(a, { saveFailed: true, requestId: requestIdOf(a, 0) });
    await done;
    a.destroyed = true;
  });

  // 复审:退出被取消时,被本轮接管的旧单窗关闭流程所在窗口此前仍隐藏、守卫仍在途,要等旧 ACK / 10s 超时才恢复。
  it('退出中止 → 立即恢复被接管的隐藏窗口并释放其关窗守卫;旧流程迟到 ACK 无副作用', async () => {
    const win = createReadyWindow(50);
    reportDirty(win, ds(['/w/a.ts']));
    electronMock.showMessageBox
      .mockResolvedValueOnce({ response: 1 }) // 关窗:不保存(hide + flush 在途)
      .mockResolvedValueOnce({ response: 2 }); // 退出:取消

    win.close();
    await flushMicrotasks(10);
    expect(win.hide).toHaveBeenCalledTimes(1);
    const closeReq = requestIdOf(win, 0);
    await beforeQuit().done;
    expect(app.quit).not.toHaveBeenCalled();
    expect(win.show).toHaveBeenCalledTimes(1); // 不等旧 ACK

    // 守卫已释放:再次关闭重新确认(不卡在「flush 在途」)
    electronMock.showMessageBox.mockReturnValueOnce(new Promise(() => undefined));
    win.close();
    await flushMicrotasks(10);
    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(3);

    // 旧流程的迟到 ACK:被取代,不关窗、不再 show
    ack(win, { requestId: closeReq });
    await flushMicrotasks(10);
    expect(win.destroyed).toBe(false);
    expect(win.show).toHaveBeenCalledTimes(1);
    win.destroyed = true;
  });

  // 终审 P1:before-quit 同类路径。未弹框窗口 pendingAutoSave 非空且 flush 超时 → 中止退出、显示该窗口;
  // 同轮另一个 pendingAutoSave 为空的超时窗口不阻止(只显示需中止的窗口)。
  it('未弹框窗口 pendingAutoSave 非空 + flush 超时 → 中止退出(不清理 PTY)、显示该窗口、守卫复位', async () => {
    vi.useFakeTimers();
    const a = createReadyWindow(63);
    const b = createReadyWindow(64);
    reportDirty(a, { ...ds([]), pendingAutoSave: ['/w/a.md#1'] });

    const { done } = beforeQuit();
    await flushMicrotasks(10);
    expect(electronMock.showMessageBox).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FLUSH_ACK_TIMEOUT_MS);
    await done;
    expect(app.quit).not.toHaveBeenCalled();
    expect(termService.cleanupAll).not.toHaveBeenCalled();
    expect(a.show).toHaveBeenCalled();
    expect(b.show).not.toHaveBeenCalled();

    // 守卫复位:再次 Cmd+Q 重新发 flush(不卡在「清理在途」)
    vi.useRealTimers();
    const second = beforeQuit();
    await flushMicrotasks(10);
    expect(flushRequests(a)).toHaveLength(2);
    ack(a, { requestId: requestIdOf(a, 1), state: ds([]) });
    ack(b, { requestId: requestIdOf(b, 1), saveFailed: true });
    reportDirty(a, ds(['/w/x.ts'])); // 让第二轮全局最终检查中止,保持守卫可用于后续用例
    await second.done;
    expect(app.quit).not.toHaveBeenCalled();
    a.destroyed = true;
    b.destroyed = true;
  });

  it('逐窗确认后按各自选择 flush,全部完成再退出', async () => {
    const a = createReadyWindow(23);
    const b = createReadyWindow(24);
    const clean = createReadyWindow(25);
    const popout = new electronMock.MockBrowserWindow();
    popout.webContents.getURL.mockReturnValue('file:///renderer/index.html?popout=1');
    reportDirty(a, ds(['/w/a.ts']));
    reportDirty(b, ds(['/w/a.ts', 'untitled-1'], ['untitled-1']));
    electronMock.showMessageBox
      .mockResolvedValueOnce({ response: 0 }) // a 保存
      .mockResolvedValueOnce({ response: 1 }); // b 不保存

    const { done } = beforeQuit();
    await flushMicrotasks(10);
    expect(electronMock.showMessageBox).toHaveBeenCalledTimes(2);
    expect(flushRequests(a)).toEqual([{ windowId: a.id, save: true, requestId: expect.any(Number) }]);
    expect(flushRequests(b)).toEqual([
      { windowId: b.id, discard: true, requestId: expect.any(Number) },
    ]);
    expect(flushRequests(clean)).toEqual([{ windowId: clean.id, requestId: expect.any(Number) }]);

    // 复审:选「保存」后 tab 变干净,干净状态此前要等 renderer 之后的 useEffect 上报;main 可能先用旧脏集合做
    // 全局最终检查而误中止退出。回执始终携带 flush 后的最终脏态(含空集合),main 以其更新记账 ——
    // 这里 a 不再另发脏态上报,只靠回执。
    ack(a, { saveFailed: false, state: ds([]) });
    // 全局最终检查:a 保存后干净;b「不保存」仍是确认时的脏数(在接受范围内)→ 照常退出。
    reportDirty(b, ds(['/w/a.ts', 'untitled-1'], ['untitled-1']));
    // 插件 shell 子进程清理在途时不得退出(须被 await,否则 detached 进程组在 IDE 退出后继续运行)。
    let releaseShell: () => void = () => {};
    vi.mocked(shellService.cleanupAllShellExecs).mockImplementationOnce(
      () => new Promise<void>((r) => (releaseShell = r)),
    );
    ack(b);
    ack(clean);
    await flushMicrotasks(10);
    expect(shellService.cleanupAllShellExecs).toHaveBeenCalledTimes(1);
    expect(shellStream.cleanupAllShellStreams).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();
    releaseShell();
    await done;
    expect(termService.cleanupAll).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
    // 窗口已隐藏、无人应答授权弹窗:未决 agent 授权在关闭 MCP host 前同步拒绝,不拖到无应答超时(2 分钟)。
    expect(agentAuth.cancelAllAgentAuth).toHaveBeenCalledTimes(1);
    // 复审:全局最终检查通过后、不可逆清理(cleanupAll 可能数秒)前隐藏全部窗口(含 popout)形成退出屏障 ——
    // 否则清理期间窗口仍可编辑,且已入 flushedOnQuit,之后的编辑丢失、用户关窗也绕过确认。
    for (const w of [a, b, clean, popout]) {
      expect(w.hide).toHaveBeenCalled();
      expect(w.hide.mock.invocationCallOrder[0]!).toBeLessThan(
        vi.mocked(termService.cleanupAll).mock.invocationCallOrder[0]!,
      );
    }
  });
});
