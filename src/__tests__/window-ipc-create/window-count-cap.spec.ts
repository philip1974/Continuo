// 安全(审计 F4):renderer 发起的新建窗口此前无数量上限 —— 第三方插件循环执行 window.new,每个新窗口重新加载该
// 插件 → 指数开窗。修复:window:create 在全局主窗口数(含正在创建的)达到 MAX_APP_WINDOWS 时拒绝(TOO_MANY_WINDOWS)。
// 行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type InvokeHandler = (event: { sender: object; senderFrame: { url: string } }, raw: unknown) => unknown;

const h = vi.hoisted(() => ({ handlers: new Map<string, InvokeHandler>(), nextId: 100 }));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), on: vi.fn() },
  ipcMain: { handle: vi.fn((channel: string, fn: InvokeHandler) => h.handlers.set(channel, fn)) },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));
vi.mock('../../../electron/main/persistence', () => ({
  // 让分配 seq 有一点异步间隔:并发请求都在「检查之后、建窗之前」排队,验证在途计数
  allocateWindowSeq: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 1));
    return h.nextId;
  }),
}));

const { WINDOW_CHANNELS } = await import('../../../electron/shared/window-channels');
const { registerWindowIpc, MAX_APP_WINDOWS } = await import('../../../electron/main/ipc/window.ipc');
const { setWindowSeq, clearWindow, windowSeqCount } = await import(
  '../../../electron/main/services/window-seq.service'
);

const opened: number[] = [];
/** 与真实 createMainWindow 一样登记 windowSeq(主窗口数据源)。 */
const createMainWindow = vi.fn(({ windowSeq }: { windowSeq: number }) => {
  const id = h.nextId++;
  setWindowSeq(id, windowSeq);
  opened.push(id);
  return { id };
});
const createWin = (): unknown =>
  h.handlers.get(WINDOW_CHANNELS.CREATE)!({ sender: {}, senderFrame: { url: 'file:///renderer/index.html' } }, {});

beforeEach(() => {
  h.handlers.clear();
  createMainWindow.mockClear();
  registerWindowIpc({ createMainWindow });
  setWindowSeq(1, 0); // 主窗
  opened.push(1);
});

afterEach(() => {
  for (const id of opened.splice(0)) clearWindow(id);
});

describe('window:create 全局窗口数上限', () => {
  it(`并发请求 100 次:主窗口总数不超过 ${MAX_APP_WINDOWS},超出部分 TOO_MANY_WINDOWS`, async () => {
    const results = (await Promise.all(Array.from({ length: 100 }, createWin))) as { ok: boolean; code?: string }[];
    expect(windowSeqCount()).toBe(MAX_APP_WINDOWS);
    expect(createMainWindow).toHaveBeenCalledTimes(MAX_APP_WINDOWS - 1);
    const denied = results.filter((r) => !r.ok);
    expect(denied).toHaveLength(100 - (MAX_APP_WINDOWS - 1));
    expect(denied[0]).toMatchObject({ ok: false, code: 'TOO_MANY_WINDOWS' });
  });

  it('关闭窗口后名额释放;未达上限时单次新建照常', async () => {
    expect(await createWin()).toMatchObject({ ok: true });
    while (windowSeqCount() < MAX_APP_WINDOWS) await createWin();
    expect(await createWin()).toMatchObject({ ok: false, code: 'TOO_MANY_WINDOWS' });
    clearWindow(opened.pop()!);
    expect(await createWin()).toMatchObject({ ok: true });
  });
});
