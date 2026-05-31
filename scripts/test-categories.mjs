// 测试分层的单一真相源:被 vitest.workspace.ts 与 scripts/bdd-index.mjs 共用,
// 避免双份硬编码漂移。
//
// 三档语义:
//  - contract:稳定外部契约层(API ref / 协议帧 / 契约)。改动需更高 review 优先级。
//  - integration:跨进程 / 多窗口 / IPC / MCP host 等纵向链路用例。
//  - 默认全部归 unit。
//
// glob 形式给 vitest 用,slug 形式给 bdd-index 用。

/** @type {string[]} BDD topic slugs (src/__tests__/ 下目录名)。 */
export const CONTRACT_TOPICS = [
  'co-api',
  'dock-api-ref',
  'animation-contracts',
  'decor-contracts',
  'popout-contracts',
  'agent-terminal-mcp-stdio-framing',
  'plugin-mcp-invoke-bridge',
  'plugin-mcp-ipc-bridge',
  'sdk-contract',
];

/** @type {string[]} BDD topic slugs。 */
export const INTEGRATION_TOPICS = [
  'plugin-mcp-e2e',
  'plugin-mcp-multi-window',
  'terminal-ipc',
  'terminal-write',
  'terminal-sessions-service',
  'terminal-window-isolation',
  'window-aware-agent-session',
];

/** 把 topic slugs 数组转成 vitest include glob 数组。 */
export function toIncludeGlobs(slugs) {
  return slugs.map((s) => `src/__tests__/${s}/**/*.{spec,test}.{ts,tsx}`);
}

/** integration project 的完整 include(含 src/integration/ 占位目录)。 */
export const INTEGRATION_INCLUDE = [
  'src/integration/**/*.{spec,test}.{ts,tsx}',
  ...toIncludeGlobs(INTEGRATION_TOPICS),
];

/** contract project 的完整 include。 */
export const CONTRACT_INCLUDE = toIncludeGlobs(CONTRACT_TOPICS);
