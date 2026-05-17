// topic-15 unified-toast-notification: main → renderer push 桥接。
// 灵感来自 Nous shell-cli SystemNotificationBridge;DOM 端适配 + windowId ingress filter。
//
// **P0-1 修订**:走 coApi.notify.onPush(不读 window 顶层 api),走 coApi.system.windowId
//   (preload 已暴露)。Sandbox sweep 不动 coApi 缓存路径。
//
// **Q6 修订**:Bridge 默认调 notify(..., { mirror: false }),因 main 端 pushNotification
//   helper 内部已 console 兜底(Op9)。
//
// **多窗口路由**:payload.windowId 缺省 → 视为 broadcast,放行;有 windowId 且 ≠
//   coApi.system.windowId → 丢弃(沿用 topic-09 ingress filter 防御性模式)。

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { coApi } from '@/lib/co-api';
import { notify } from './notify';
import type { NotifyPushPayload } from '../../electron/shared/notify-channels';

export function NotifyIpcBridge(): ReactNode {
  useEffect(() => {
    const myWindowId = coApi.system.windowId;
    const unsubscribe = coApi.notify.onPush((payload: NotifyPushPayload) => {
      // ingress filter:有 windowId 且不匹配本窗 → 丢弃;缺省 → broadcast,放行
      if (payload.windowId !== undefined && payload.windowId !== myWindowId) {
        return;
      }
      notify(payload.message, payload.level, {
        code: payload.code,
        mirror: false, // main 端 pushNotification helper 已 console 兜底
      });
    });
    return unsubscribe;
  }, []);
  return null;
}
