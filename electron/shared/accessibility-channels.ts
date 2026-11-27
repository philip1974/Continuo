// 系统读屏检测(VSCode:main 用 app.isAccessibilitySupportEnabled() 给窗口初值,app 'accessibility-support-changed'
// 时 sendToAll 'vscode:accessibilitySupportChanged';renderer AccessibilityService 据此 + editor.accessibilitySupport
// 判定 isScreenReaderOptimized)。preload 值导入本文件:不得引入 zod(见 preload-no-zod 守卫)。
// BDD: src/__tests__/terminal-screen-reader/

export const ACCESSIBILITY_CHANNELS = {
  /** renderer → main:当前是否检测到辅助技术(读屏)。返回 boolean。 */
  GET_SUPPORT: 'accessibility:get-support',
  /** main → renderer:系统辅助技术状态变化,广播到所有窗口。payload `{ enabled }`。 */
  SUPPORT_CHANGED: 'accessibility:support-changed',
} as const;

export interface AccessibilitySupportChangedPayload {
  readonly enabled: boolean;
}

/** SUPPORT_CHANGED 推送的 runtime 守卫(preload guardedListener 用)。 */
export function isAccessibilitySupportChangedPayload(value: unknown): value is AccessibilitySupportChangedPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { enabled?: unknown }).enabled === 'boolean'
  );
}
