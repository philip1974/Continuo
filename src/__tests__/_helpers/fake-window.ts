// 测试共享 helper:最小假 BrowserWindow(`{ id?, isDestroyed, webContents: { send } }`)。
// 只覆盖这一种形态;需要 once / on / getURL / webContents.isDestroyed 等额外成员的用例请就地手写。
import { vi, type Mock } from 'vitest';

export interface FakeWinOpts {
  /** 给出时结果带 `id` 字段;不给则没有 `id`(与只读 isDestroyed / webContents 的被测代码保持同形)。 */
  id?: number;
  /** isDestroyed() 的返回值,默认 false。 */
  destroyed?: boolean;
  /** true → webContents.send 抛 `Object has been destroyed`(模拟检查后、发送前窗口被销毁)。 */
  throwOnSend?: boolean;
}

export interface FakeWin {
  isDestroyed: () => boolean;
  webContents: { send: Mock<(channel: string, ...args: unknown[]) => void> };
}

export function makeFakeWin(opts: FakeWinOpts & { id: number }): FakeWin & { id: number };
export function makeFakeWin(opts?: FakeWinOpts): FakeWin;
export function makeFakeWin(opts: FakeWinOpts = {}): FakeWin & { id?: number } {
  const { id, destroyed = false, throwOnSend = false } = opts;
  const send = vi.fn((_channel: string, ..._args: unknown[]): void => {
    if (throwOnSend) throw new Error('Object has been destroyed');
  });
  const win: FakeWin = { isDestroyed: () => destroyed, webContents: { send } };
  return id === undefined ? win : { id, ...win };
}
