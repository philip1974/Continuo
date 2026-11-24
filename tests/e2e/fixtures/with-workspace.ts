// 扩展 fixture:在 userData 预置 explorer.json,Continuo 启动时自动 hydrate
// 一个真实临时工作区目录(放几个文件)。
//
// 用法:
//   import { test, expect } from '../fixtures/with-workspace';
//   test('xx', async ({ window, workspaceRoot }) => { ... });

import { test as base, expect } from '@playwright/test';
import type { Page, ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureMainProcessLog, closeDiscardingUnsaved } from '../helpers/close-app';
import { launchContinuo } from '../helpers/launch';
import { seedExplorerJson } from '../helpers/seed-explorer';

interface Fixtures {
  electronApp: ElectronApplication;
  window: Page;
  userDataDir: string;
  workspaceRoot: string;
}

export const test = base.extend<Fixtures>({
  userDataDir: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'continuo-e2e-ud-'));
    await use(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* */
    }
  },

  workspaceRoot: async ({}, use) => {
    const root = mkdtempSync(path.join(tmpdir(), 'continuo-e2e-ws-'));
    // 预置文件树:
    //   /README.md
    //   /src/a.ts
    //   /src/b.ts
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'README.md'), '# Test Workspace\n');
    writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(root, 'src/b.ts'), 'export const b = 2;\n');
    await use(root);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* */
    }
  },

  electronApp: async ({ userDataDir, workspaceRoot }, use, testInfo) => {
    // 写入 explorer.json,让 hydrate 自动设 root
    seedExplorerJson(userDataDir, { root: workspaceRoot });

    const app = await launchContinuo(userDataDir);
    captureMainProcessLog(app, testInfo.outputDir);
    await use(app);
    await closeDiscardingUnsaved(app);
  },

  window: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },
});

export { expect };
