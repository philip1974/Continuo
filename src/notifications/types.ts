// topic-15 unified-toast-notification: Notification 类型基线。
// 灵感来自 Nous shell-cli/ink/notifications/types.ts;扩展 'success' level,
// 加可选 code 字段(对齐 IpcResult fail envelope)。

export type NotificationLevel = 'info' | 'warning' | 'error' | 'success';

export interface Notification {
  readonly id: string;
  readonly level: NotificationLevel;
  readonly message: string;
  readonly code?: string;
  readonly createdAt: number;
}
