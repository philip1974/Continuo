import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// 这是 base 配置,被 vitest.workspace.ts 各 project 继承(extends)。
// 多 project 拆分见 vitest.workspace.ts。
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'electron/shared'),
    },
  },
  test: {
    // include / exclude 由 vitest.workspace.ts 各 project 定义,base 不再列。
    environment: 'node',
    environmentMatchGlobs: [
      // 默认 node;需要 DOM / localStorage 的 spec 单独走 jsdom
      ['src/__tests__/design-system/**', 'jsdom'],
      ['src/__tests__/settings-values/**', 'jsdom'],
      ['src/__tests__/keybindings-store/**', 'jsdom'],
      ['src/__tests__/local-storage-record-guard/**', 'jsdom'],
      // topic-05: DataTransfer / document / requestAnimationFrame / React testing
      ['src/__tests__/terminal-tab-drag-split/**', 'jsdom'],
      ['src/__tests__/terminal-drag-drop/**', 'jsdom'],
      // topic-22: KeyboardEvent / DockShell sanitize import path
      ['src/__tests__/22-pane-zoom-toggle/**', 'jsdom'],
    ],
    setupFiles: ['src/__tests__/design-system/setup.ts'],
    globals: false,
  },
});
