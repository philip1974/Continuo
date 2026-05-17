// topic-15 unified-toast-notification: 公共 notify API + 模块级单例 + console mirror。
//
// **`mirror` 语义文档化(plan-v4 P2-2 修订)**:
//   - 默认 mirror=true:notify 同步把消息写到对应 console 级别(error→console.error /
//     warning→console.warn / info,success→console.log),保证 debug/CI 无 Toast 也能看见。
//   - mirror=false **仅当调用方确认已有外部日志**:
//     * Bridge 从 main push 收消息时,main 端 `pushNotification` helper 内部已 console
//       兜底(Op9),Bridge 调 `notify(..., { mirror: false })` 避免双写。
//     * Renderer 内 alert 收编时若原代码已 `console.warn([prefix] ...)` 同义 → 保留
//       原 console + `notify(..., { mirror: false })`(plan-v4 P1-4 修订:不删 console)。
//   - 不要在没有外部日志的位置传 mirror:false,否则错误会"静默"。
//
// **epoch race 防护**:Provider mount 时调 `__registerHandle(api, epoch)`,unmount 时调
//   `__registerHandle(null, epoch)`;模块层只接受最新 epoch 的清空请求(防 StrictMode 双
//   mount 顺序里旧 Provider 卸载清新单例)。

import type { NotificationLevel } from './types';

export interface NotifyOpts {
  readonly code?: string;
  readonly mirror?: boolean;
}

export interface NotifyApi {
  readonly notify: (
    message: string,
    level?: NotificationLevel,
    opts?: NotifyOpts,
  ) => void;
  readonly dismiss: (id: string) => void;
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

/** 底层:notify(message, level?, opts?) */
function notifyCore(
  message: string,
  level: NotificationLevel = 'info',
  opts?: NotifyOpts,
): void {
  if (opts?.mirror !== false) {
    mirrorToConsole(level, message, opts?.code);
  }
  // Provider 未 mount 时:仅 console mirror,不 buffer(简化,见 plan-v4 Op6 决定)
  _api?.notify(message, level, opts);
}

type SugarOpts = Omit<NotifyOpts, 'level'>;

interface NotifyPublic {
  (message: string, level?: NotificationLevel, opts?: NotifyOpts): void;
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
