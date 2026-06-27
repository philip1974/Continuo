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

// 边界(E168,IPC ingress 纵深防御):NotifyIpcBridge 此前只按 TS 类型信任 notify:push payload,
// 不做 runtime 形态/长度校验。虽然当前 pushNotification 无生产调用方、且发送方是 main 内部(payload
// 非外部/插件直接控制),仍补齐与 bridge 既有防御姿态(windowId ingress filter + empty-drop)一致的
// runtime type guard:非法 payload(null/非对象/非法 level/超长 message·code/畸形 params/非安全
// windowId)→ drop + warn,不让畸形数据进通知队列或令 bridge 回调抛错。
export const NOTIFY_LEVELS: readonly NotifyLevel[] = [
  'info',
  'warning',
  'error',
  'success',
];
export const NOTIFY_MESSAGE_MAX = 4096; // toast 文本上限
export const NOTIFY_CODE_MAX = 256; // error code 上限
export const NOTIFY_PARAMS_MAX_KEYS = 64; // 插值参数条数上限
export const NOTIFY_PARAM_VALUE_MAX = 2048; // 单个 string 参数值上限

function isValidParams(v: unknown): boolean {
  if (v === undefined) return true;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  // 边界(E213,E197/E199 有界迭代族):单次 for...in 边计数边校验,不先 Object.keys 把畸形 notify:push
  // payload 的所有参数 key 全量物化再判上限(NOTIFY_PARAMS_MAX_KEYS 否则在物化之后才生效)。超上限立即 false。
  let count = 0;
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    count += 1;
    if (count > NOTIFY_PARAMS_MAX_KEYS) return false;
    const val = obj[k];
    if (typeof val === 'string') {
      if (val.length > NOTIFY_PARAM_VALUE_MAX) return false;
    } else if (typeof val === 'number') {
      if (!Number.isFinite(val)) return false;
    } else {
      return false; // 仅允许 string | number 插值值
    }
  }
  return true;
}

/** notify:push payload 的 runtime 形态 + 长度守卫(IPC ingress 纵深防御,E168)。 */
export function isNotifyPushPayload(v: unknown): v is NotifyPushPayload {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (!NOTIFY_LEVELS.includes(obj.level as NotifyLevel)) return false;
  if (
    obj.message !== undefined &&
    (typeof obj.message !== 'string' || obj.message.length > NOTIFY_MESSAGE_MAX)
  ) {
    return false;
  }
  if (
    obj.code !== undefined &&
    (typeof obj.code !== 'string' || obj.code.length > NOTIFY_CODE_MAX)
  ) {
    return false;
  }
  if (!isValidParams(obj.params)) return false;
  if (
    obj.windowId !== undefined &&
    (typeof obj.windowId !== 'number' ||
      !Number.isSafeInteger(obj.windowId) ||
      obj.windowId < 0)
  ) {
    return false;
  }
  return true;
}
