// Playwright fixture:每个 spec 启一个新 Electron 实例,自动 close.
//
// 用法:
//   import { test, expect } from '../fixtures/electron-app';
//   test('xxx', async ({ window }) => { ... });
//
// 设计:
//   - 每个 spec 独立 user-data-dir(放在 tmp),避免互相污染 explorer.json /
//     localStorage。
//   - test 作用域 fixture:每个用例结束时清理,删除整个 tmp 目录。

import { test as base, type Page, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureMainProcessLog, closeDiscardingUnsaved } from '../helpers/close-app';
import { launchContinuo } from '../helpers/launch';

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

  electronApp: async ({ userDataDir }, use, testInfo) => {
    const app = await launchContinuo(userDataDir);
    captureMainProcessLog(app, testInfo.outputDir);
    await use(app);
    await closeDiscardingUnsaved(app);
  },

  window: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    // 等 DOM 就绪(domcontentloaded);各用例自行等待所需元素
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },
});

export { expect } from '@playwright/test';
