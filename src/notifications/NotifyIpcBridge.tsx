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
import { translate as i18nTranslate } from '@/i18n';
import { notify } from './notify';
import {
  isNotifyPushPayload,
  type NotifyPushPayload,
} from '../../electron/shared/notify-channels';

export function NotifyIpcBridge(): ReactNode {
  useEffect(() => {
    const myWindowId = coApi.system.windowId;
    const unsubscribe = coApi.notify.onPush((payload: NotifyPushPayload) => {
      // 边界(E168):IPC ingress 纵深防御 —— 先 runtime 形态/长度校验,畸形 payload(null/非对象/
      // 非法 level/超长 message·code/畸形 params/非安全 windowId)drop + warn,不进通知队列/不抛。
      if (!isNotifyPushPayload(payload)) {
        console.warn('[notify-bridge] invalid payload, dropped', payload);
        return;
      }
      // ingress filter:有 windowId 且不匹配本窗 → 丢弃;缺省 → broadcast,放行
      if (payload.windowId !== undefined && payload.windowId !== myWindowId) {
        return;
      }

      // topic 16 Op12 catalog ingress 决策树（议题 P1-3）：
      //   1. 有 code → 查 errors.<CODE> catalog（{params} 插值）
      //   2. 否则 → 直接用 message
      //   3. 都没有 → warn + drop
      let text: string | null = null;
      if (payload.code) {
        const key = `errors.${payload.code}`;
        const translated = i18nTranslate(key, payload.params);
        // catalog miss 会回退 key 本身;此时继续走 payload.message fallback。
        if (translated !== key) text = translated;
      }
      if (!text && payload.message) text = payload.message;
      if (!text) {
         
        console.warn('[notify-bridge] empty payload, dropped', payload);
        return;
      }

      notify(text, payload.level, {
        code: payload.code,
        mirror: false, // main 端 pushNotification helper 已 console 兜底
      });
    });
    return unsubscribe;
  }, []);
  return null;
}
