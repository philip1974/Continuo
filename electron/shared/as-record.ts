/** plain object 判定(非 null、非数组的对象)。main 元数据表 / 权限记录契约 / renderer 权限解析共用(此前 3 份逐字副本)。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把未知值当作 plain object 读取:非对象 / null / 数组 → 空对象(调用方随后逐字段做类型检查)。
 * main debug.service 解析 DAP body 与 renderer debug.store 解析推送 payload 共用。
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
