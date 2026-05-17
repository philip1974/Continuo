// topic-15 unified-toast-notification: main → renderer push 通道常量与 payload 类型。
// main 端 BrowserWindow.webContents.send(NOTIFY_CHANNELS.PUSH, payload);
// renderer 端通过 coApi.notify.onPush(listener) 订阅。

export const NOTIFY_CHANNELS = {
  PUSH: 'notify:push',
} as const;

export type NotifyChannel = (typeof NOTIFY_CHANNELS)[keyof typeof NOTIFY_CHANNELS];

export type NotifyLevel = 'info' | 'warning' | 'error' | 'success';

export interface NotifyPushPayload {
  readonly level: NotifyLevel;
  readonly message: string;
  readonly code?: string;
  /** 目标窗口 id;缺省 → broadcast 全 BrowserWindow */
  readonly windowId?: number;
}
