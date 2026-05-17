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
  /** 可选：旧调用方仍可直接发 message；新调用方应发 code+params 走 catalog（topic 16）。 */
  readonly message?: string;
  readonly code?: string;
  /** 与 errors.<CODE> 模板插值（{path}/{workspace} 等）；topic 16 catalog ingress 用。 */
  readonly params?: Readonly<Record<string, string | number>>;
  /** 目标窗口 id;缺省 → broadcast 全 BrowserWindow */
  readonly windowId?: number;
}
