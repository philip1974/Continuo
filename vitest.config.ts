import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      // 默认 node;design-system 等需要 DOM 的 spec 单独走 jsdom
      ['src/__tests__/design-system/**', 'jsdom'],
    ],
    setupFiles: ['src/__tests__/design-system/setup.ts'],
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
    globals: false,
  },
});
