// topic-15 unified-toast-notification: main 端 push helper。
//
// **Q6 修订**:helper 内部强制 console 兜底(error/warn/log),renderer NotifyIpcBridge
// 默认 mirror=false 安全 — 调用方无需自行 log。
//
// **本 topic 不接入 producer**:此 helper 只是 infrastructure,真实 producer
// (PTY exit / file watcher / auth revoke 等)接入留 future topic 16+。

import { BrowserWindow } from 'electron';
import { NOTIFY_CHANNELS } from '../../shared/notify-channels';
import type { NotifyPushPayload } from '../../shared/notify-channels';

function logFallback(payload: NotifyPushPayload): void {
  const tag = '[notify-push]';
  switch (payload.level) {
    case 'error':
      console.error(tag, payload);
      break;
    case 'warning':
      console.warn(tag, payload);
      break;
    case 'info':
    case 'success':
      console.log(tag, payload);
      break;
  }
}

/**
 * 向 renderer 推送 toast。
 *
 * 路由策略:
 * - payload.windowId 存在 → BrowserWindow.fromId(id).webContents.send(...)
 * - payload.windowId 缺省 → broadcast 到全部 BrowserWindow(沿用 topic-09 ingress filter)
 *
 * 内部强制 console 兜底,renderer Bridge mirror=false 安全。
 */
export function pushNotification(payload: NotifyPushPayload): void {
  logFallback(payload);

  // race(R70,R62-R68 同族):isDestroyed() 检查后、send 前窗口可能销毁,send 抛
  // "Object has been destroyed"。pushNotification 常被失败处理路径当兜底反馈调用,定向 send 裸抛
  // 会**反过来遮蔽原业务错误处理**;广播 send 裸抛会中断循环使后续窗口漏收通知。每次 send 独立
  // try/catch,失败只记录(logFallback 已 console 过 payload)并继续。
  if (payload.windowId !== undefined) {
    const win = BrowserWindow.fromId(payload.windowId);
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send(NOTIFY_CHANNELS.PUSH, payload);
      } catch (err) {
        console.error('[notify-push] targeted send failed', err);
      }
    }
    return;
  }

  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      w.webContents.send(NOTIFY_CHANNELS.PUSH, payload);
    } catch (err) {
      console.error('[notify-push] broadcast send failed', err);
    }
  }
}
