// topic-15 unified-toast-notification: 公共 notify API + 模块级单例 + console mirror。
//
// **`mirror` 语义文档化(plan-v4 P2-2 修订)**:
//   - 默认 mirror=true:notify 同步把消息写到对应 console 级别(error→console.error /
//     warning→console.warn / info,success→console.log),保证 debug/CI 无 Toast 也能看见。
//   - mirror=false **仅当调用方确认已有外部日志**:
//     * Renderer 内 alert 收编时若原代码已 `console.warn([prefix] ...)` 同义 → 保留
//       原 console + `notify(..., { mirror: false })`(plan-v4 P1-4 修订:不删 console)。
//   - 不要在没有外部日志的位置传 mirror:false,否则错误会"静默"。
//
// **epoch race 防护**:Provider mount 时调 `__registerHandle(api, epoch)`,unmount 时调
//   `__registerHandle(null, epoch)`;模块层只接受最新 epoch 的清空请求(防 StrictMode 双
//   mount 顺序里旧 Provider 卸载清新单例)。

import type { NotificationLevel } from './types';
// 边界(E311):所有通知(本地与 SDK co-app)的限长只在 notifyCore 一处做,上限取共享常量。
import {
  NOTIFY_MESSAGE_MAX,
  NOTIFY_CODE_MAX,
} from '../../electron/shared/notify-channels';

/** 通知上的操作按钮(VSCode 通知的 primary actions,如保存失败的「另存为… / 重试」):点击即执行并关闭该通知。 */
export interface NotifyAction {
  readonly label: string;
  readonly run: () => void;
}

/** 一条通知最多带的按钮数(VSCode 通知 toast 同样只放少量按钮)。 */
export const NOTIFY_ACTIONS_MAX = 3;

export interface NotifyOpts {
  readonly code?: string;
  readonly mirror?: boolean;
  /**
   * 操作按钮(至多 NOTIFY_ACTIONS_MAX 个,多余的丢弃)。带按钮的通知不自动消失(VSCode:带操作的错误通知常驻,直到用户
   * 点按钮或 ×),同内容合并时按钮换成最新一次的。BDD: src/__tests__/editor-save-as/
   */
  readonly actions?: readonly NotifyAction[];
}

export interface NotifyApi {
  readonly notify: (
    message: string,
    level: NotificationLevel,
    opts?: NotifyOpts,
  ) => void;
}

let _api: NotifyApi | null = null;
let _currentEpoch = 0;

/** Provider 内部使用,renderer 业务代码不要直接调。 */
export function __registerHandle(api: NotifyApi | null, epoch: number): void {
  if (api !== null) {
    _api = api;
    _currentEpoch = epoch;
    return;
  }
  // unregister: 仅当 epoch === 当前 currentEpoch 才清空,防 StrictMode 旧实例卸载清新单例
  if (epoch === _currentEpoch) {
    _api = null;
  }
}

function mirrorToConsole(
  level: NotificationLevel,
  message: string,
  code: string | undefined,
): void {
  const prefix = code !== undefined ? `[${code}]` : '[notify]';
  switch (level) {
    case 'error':
      console.error(prefix, message);
      break;
    case 'warning':
      console.warn(prefix, message);
      break;
    case 'info':
    case 'success':
      console.log(prefix, message);
      break;
  }
}

/** 底层:notify(message, level, opts?) */
function notifyCore(
  message: string,
  level: NotificationLevel,
  opts?: NotifyOpts,
): void {
  // 边界(E311):所有通知(本地 notify 与 SDK coApp.notifications.show)的限长只在这唯一入口做。renderer 各处
  // notify.error(err.message) 的 err.message 可超长(畸形 / 插件抛超长串)→ 进 console mirror + Toast DOM 放大:
  // message 截断到 NOTIFY_MESSAGE_MAX(保留可见反馈);code 是标识符,超长 / 空串丢弃(截断只会得到不存在的 code)。
  const cappedMessage =
    message.length > NOTIFY_MESSAGE_MAX
      ? message.slice(0, NOTIFY_MESSAGE_MAX)
      : message;
  const rawCode = opts?.code;
  const codeOk = rawCode === undefined || (rawCode.length > 0 && rawCode.length <= NOTIFY_CODE_MAX);
  const actionsOk = opts?.actions === undefined || opts.actions.length <= NOTIFY_ACTIONS_MAX;
  const cappedOpts =
    codeOk && actionsOk
      ? opts
      : {
          ...opts,
          ...(codeOk ? null : { code: undefined }),
          ...(actionsOk ? null : { actions: opts!.actions!.slice(0, NOTIFY_ACTIONS_MAX) }),
        };
  if (cappedOpts?.mirror !== false) {
    mirrorToConsole(level, cappedMessage, cappedOpts?.code);
  }
  // Provider 未 mount 时:仅 console mirror,不 buffer(简化,见 plan-v4 Op6 决定)
  _api?.notify(cappedMessage, level, cappedOpts);
}

type SugarOpts = NotifyOpts;

interface NotifyPublic {
  (message: string, level: NotificationLevel, opts?: NotifyOpts): void;
  error(message: string, opts?: SugarOpts): void;
  warn(message: string, opts?: SugarOpts): void;
  info(message: string, opts?: SugarOpts): void;
  success(message: string, opts?: SugarOpts): void;
}

const _notify: NotifyPublic = notifyCore as NotifyPublic;
_notify.error = (message, opts) => notifyCore(message, 'error', opts);
_notify.warn = (message, opts) => notifyCore(message, 'warning', opts); // 糖函数名 warn → 内部 level 'warning'(贴 Nous)
_notify.info = (message, opts) => notifyCore(message, 'info', opts);
_notify.success = (message, opts) => notifyCore(message, 'success', opts);

export const notify = _notify;
