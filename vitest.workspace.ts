import { defineWorkspace } from 'vitest/config';

// integration project 包含的目录:跨进程 IPC、MCP host/protocol、terminal session
// 等需要更重启动/mock 的纵向链路用例。其余默认进 unit。
//
// src/integration/ 目前是占位(只有 README.md),未来纵向链路用例搬入。
const INTEGRATION_INCLUDE = [
  'src/integration/**/*.{spec,test}.{ts,tsx}',
  'src/__tests__/plugin-mcp-e2e/**/*.{spec,test}.{ts,tsx}',
  'src/__tests__/plugin-mcp-ipc-bridge/**/*.{spec,test}.{ts,tsx}',
  'src/__tests__/plugin-mcp-multi-window/**/*.{spec,test}.{ts,tsx}',
  'src/__tests__/terminal-ipc/**/*.{spec,test}.{ts,tsx}',
  'src/__tests__/terminal-write/**/*.{spec,test}.{ts,tsx}',
  'src/__tests__/terminal-sessions-service/**/*.{spec,test}.{ts,tsx}',
];

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['src/**/*.{spec,test}.{ts,tsx}'],
      exclude: INTEGRATION_INCLUDE,
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: INTEGRATION_INCLUDE,
    },
  },
]);
