// 向所有存活窗口广播的单一实现(重构:plugins / i18n / notify / fs / terminal 五个 IPC 模块此前
// 各手写同一个循环,race R64/R66/R67/R68/R70 逐个补 try/catch)。
//
// race(R63-R70 族):isDestroyed() 检查后、send 前窗口仍可能销毁,send 抛 "Object has been
// destroyed"。裸抛会(1)中断循环 → 坏窗口之后的窗口漏收广播,停在旧状态;(2)冒泡回调用方
// (watcher 回调 / IPC handler / 失败兜底通知)遮蔽原业务结果。故每个窗口的取 payload + send 独立
// try/catch,失败只记录并继续。

import { BrowserWindow } from 'electron';

/**
 * @param payloadFor 按窗口给出 payload(固定 payload 传 `() => payload`;也可按 ownerWindowId 过滤快照)
 * @param tag 失败日志前缀(如 `[fs] DIR_CHANGED`)
 */
export function broadcastToWindows(
  channel: string,
  payloadFor: (win: BrowserWindow) => unknown,
  tag: string,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payloadFor(win));
    } catch (err) {
      console.error(`${tag} broadcast failed`, err);
    }
  }
}
