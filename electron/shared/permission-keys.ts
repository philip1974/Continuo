// 插件权限枚举的跨进程单一来源(重构:此前定义在 src/plugins/permissions.ts,main 的 plugins.service
// 反向从 src/ 导入)。src/plugins/permissions.ts 原样 re-export。

// 可维护性 M8:权限枚举单一来源 —— union 从 PERMISSION_KEYS 常量派生,避免手写 union
// 与数组双重维护(新增权限只改这一处);manifest schema 直接 z.enum(PERMISSION_KEYS),
// 不再 `as unknown as [PermissionKey, ...]` 绕过 z.enum 的非空 tuple 要求。
export const PERMISSION_KEYS = [
  'fs',
  'network',
  'shell',
  'clipboard',
  /** v5 Phase 4:plugin 注册 MCP tool 给 Agent 用. */
  'mcp-tools',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];
