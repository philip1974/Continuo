import { defineConfig } from '@playwright/test';

// e2e 跑构建好的 Electron app。
// 启动入口 = out/main/index.js,Playwright `_electron.launch` 会接管子进程 +
// 给我们一个 ElectronApplication handle,从中取 firstWindow 拿 Page。
//
// 前置:`pnpm build` 先把 main / preload / renderer 编出来。
// CI 与本地都强制 build 一次(reuseExisting=false),避免 stale 产物误报通过。

export default defineConfig({
  testDir: './tests/e2e',
  // Electron 应用单实例多窗口语义,顺序跑更稳;并行需多 user-data-dir,本期不投资
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    actionTimeout: 5_000,
    // launch 后第一个 window 的 navigation
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
    // _electron.launch 不用 baseURL;每个 spec 通过 fixture 启 app
  },
});
