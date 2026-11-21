// Terminal session originHint — 单源真理,避免 main / preload / renderer 各处
// 散乱内联 `'user' | 'agent'` 字面值导致改时漏改。
//
// 'user'  = 用户主动按 Cmd+T / ActionHeader + / Explorer "Open in Terminal"
// 'agent' = 外部 agent 通过 MCP `terminal_create_session` tool 触发
//
// reconciler 用此字段决定:user origin → 立即 focus 新 panel;agent origin
// → 不抢 focus(参考 DockReconciler.ts)。

export const ORIGIN_HINTS = ['user', 'agent'] as const;

export type OriginHint = (typeof ORIGIN_HINTS)[number];
