// 边界(E273,E271 registry 族):贡献 registry 的 validate*Spec 在读 spec.id/spec.name 等字段前,须先
// 校验 spec 本身是普通对象。spec 来自第三方未类型化 JS 插件,TS 类型不构成运行时保证 —— 传 null/undefined
// 会让 `spec.id` 抛非结构化 TypeError(冒泡到注册/激活路径,错误码与 UI 反馈不稳定),传 primitive/数组则
// 各字段校验虽能兜住但报"字段非法"而非"spec 非对象"的清晰错误。各 validate*Spec 开头统一用本 helper 收口。

/**
 * spec 是否为可安全读取字段的普通对象(非 null / 非 primitive / 非数组)。返回 boolean(非 type guard:
 * 避免对已 typed 的 spec 参数在 false 分支窄化为 never,见 E268)。
 */
export function isSpecObject(spec: unknown): boolean {
  return spec !== null && typeof spec === 'object' && !Array.isArray(spec);
}

// ── 各 registry 的 validate*Spec 共用的字段断言 ───────────────────────────────────────────────
// Ribbon / SettingTab / Panel / EditorAction / ExplorerContextMenu / StatusBar 六个 registry 的校验此前逐字同构
// (只差错误前缀与字段名),长度上限也各写一份。断言与上限收口到这里;错误消息格式 `[tag] field …` 不变。

/** id / type / group / *Key(i18n key)等标识类字符串的长度上限。 */
export const SPEC_ID_MAX = 256;
/** title / label 等展示文本的长度上限。 */
export const SPEC_TITLE_MAX = 512;

export function assertSpecObject(tag: string, spec: unknown): void {
  if (!isSpecObject(spec)) throw new Error(`[${tag}] spec must be an object`);
}

/** 必填:非空字符串且不超长。 */
export function assertSpecString(tag: string, field: string, value: unknown, max: number): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[${tag}] ${field} must be a non-empty string`);
  }
  if (value.length > max) throw new Error(`[${tag}] ${field} exceeds max length ${max}`);
}

/**
 * 可选:给了就必须是字符串且不超长。先 typeof 再比长度 —— spec 来自未类型化 JS 插件,
 * `(123).length === undefined > max` 为 false,只比长度会放过非字符串(E153/E155)。
 */
export function assertOptionalSpecString(
  tag: string,
  field: string,
  value: unknown,
  max: number,
): void {
  if (value === undefined) return;
  if (typeof value !== 'string') throw new Error(`[${tag}] ${field} must be a string`);
  if (value.length > max) throw new Error(`[${tag}] ${field} exceeds max length ${max}`);
}

export function assertOptionalFinitePriority(tag: string, priority: unknown): void {
  if (priority !== undefined && !Number.isFinite(priority)) {
    throw new Error(`[${tag}] priority must be finite`);
  }
}

export function assertSpecFunction(tag: string, field: string, value: unknown): void {
  if (typeof value !== 'function') throw new Error(`[${tag}] ${field} must be a function`);
}

export function assertOptionalSpecFunction(tag: string, field: string, value: unknown): void {
  if (value !== undefined) assertSpecFunction(tag, field, value);
}
