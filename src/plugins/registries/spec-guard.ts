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
