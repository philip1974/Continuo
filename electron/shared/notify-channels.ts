// topic-15 unified-toast-notification:通知的级别类型与文本上限(renderer 的 notify() 与插件 SDK 的
// app.notifications.show() 共用)。
//
// 此前这里还定义了 main → renderer 的 notify:push 通道(pushNotification / NotifyIpcBridge /
// coApi.notify.onPush),但 main 侧从来没有生产调用方,整条链路已删除;main 需要让用户看到的失败都经
// 各自的 IPC 返回值由 renderer 自己 notify。

/** 通知级别的单一来源:类型由此派生,运行时守卫(插件 notifications.show 等未校验入参)同源。 */
export const NOTIFY_LEVELS = ['info', 'warning', 'error', 'success'] as const;

export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

const NOTIFY_LEVEL_SET: ReadonlySet<unknown> = new Set(NOTIFY_LEVELS);

export function isNotifyLevel(x: unknown): x is NotifyLevel {
  return NOTIFY_LEVEL_SET.has(x);
}

export const NOTIFY_MESSAGE_MAX = 4096; // toast 文本上限
export const NOTIFY_CODE_MAX = 256; // error code 上限
