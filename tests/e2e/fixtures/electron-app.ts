// Playwright fixture:每个 spec 启一个新 Electron 实例,自动 close.
//
// 用法:
//   import { test, expect } from '../fixtures/electron-app';
//   test('xxx', async ({ window }) => { ... });
//
// 设计:
//   - 每个 spec 独立 user-data-dir(放在 tmp),避免互相污染 explorer.json /
//     localStorage。
//   - cleanup 在 afterAll 走,删除整个 tmp 目录。

import { test as base, _electron as electron, type Page, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

interface Fixtures {
  /** Electron app handle. 通过 fixture 自动 launch + close. */
  electronApp: ElectronApplication;
  /** 主窗口 Page,wait 直到 dom ready. */
  window: Page;
  /** 本次 spec 用的临时 user-data-dir(spec 结束自动清). */
  userDataDir: string;
}

export const test = base.extend<Fixtures>({
  // 每个 spec 一个全新临时 userData;Electron 用 --user-data-dir CLI 接管。
  userDataDir: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'continuo-e2e-'));
    await use(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 跨平台清理偶发 EBUSY,忽略 */
    }
  },

  electronApp: async ({ userDataDir }, use) => {
    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        // disable GPU 让 CI / headless 环境更稳;本地也无副作用
        ELECTRON_DISABLE_GPU: '1',
        // E2E 环境标识(future:让 main 跳过某些 dev-only 行为)
        CONTINUO_E2E: '1',
      },
    });
    await use(app);
    await app.close();
  },

  window: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    // 等到 React 挂载 — TitleBar 是必现元素,文本含 'Continuo'
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },
});

export { expect } from '@playwright/test';
