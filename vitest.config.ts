import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      // 默认 node;需要 DOM / localStorage 的 spec 单独走 jsdom
      ['src/__tests__/design-system/**', 'jsdom'],
      ['src/__tests__/settings-values/**', 'jsdom'],
      ['src/__tests__/keybindings-store/**', 'jsdom'],
    ],
    setupFiles: ['src/__tests__/design-system/setup.ts'],
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
    globals: false,
  },
});
