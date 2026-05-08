import { defineWorkspace } from 'vitest/config';
// @ts-expect-error mjs 共享配置,无 .d.ts
import { CONTRACT_INCLUDE, INTEGRATION_INCLUDE } from './scripts/test-categories.mjs';

// 三档语义见 scripts/test-categories.mjs:
//   contract:稳定外部契约层
//   integration:跨进程 / 多窗口 / IPC 纵向链路
//   unit:其余全部
//
// src/integration/ 是占位,future 纵向链路用例搬入。

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['src/**/*.{spec,test}.{ts,tsx}'],
      exclude: [...INTEGRATION_INCLUDE, ...CONTRACT_INCLUDE],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'integration',
      include: INTEGRATION_INCLUDE,
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'contract',
      include: CONTRACT_INCLUDE,
    },
  },
]);
