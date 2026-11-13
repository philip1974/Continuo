/**
 * ownerWindowId 必须是有限的非负整数(BrowserWindow.id)。terminal / debug 两个 sessions service 的
 * add() 入口共用(此前各持一份,只差错误前缀)。
 */
export function assertOwnerWindowId(value: unknown, label: string): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`[${label}] invalid ownerWindowId: ${String(value)}`);
  }
}
