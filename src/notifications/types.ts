// topic-15 unified-toast-notification: Notification 类型基线。
// 灵感来自 Nous shell-cli/ink/notifications/types.ts;扩展 'success' level,
// 加可选 code 字段(对齐 IpcResult fail envelope)。
//
// NotificationLevel 与 NotifyLevel(shared)字面值相同 — 复用 shared 单源,
// 别名导出让旧 import 路径(`from './types'`)不破。

import type { NotifyLevel } from '../../electron/shared/notify-channels';
import type { NotifyAction } from './notify';

export type NotificationLevel = NotifyLevel;

export interface Notification {
  readonly id: string;
  readonly level: NotificationLevel;
  readonly message: string;
  readonly code?: string;
  readonly createdAt: number;
  /** 相同内容(同 level + 同 message)合并的次数;缺省 = 1。 */
  readonly count?: number;
  /** 操作按钮(见 NotifyOpts.actions);有按钮的通知不自动消失。 */
  readonly actions?: readonly NotifyAction[];
}
