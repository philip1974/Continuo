// 扩展 fixture:在 userData 预置 explorer.json,Continuo 启动时自动 hydrate
// 一个真实临时工作区目录(放几个文件)。
//
// 用法:
//   import { test, expect } from '../fixtures/with-workspace';
//   test('xx', async ({ window, workspaceRoot }) => { ... });

import { test as base, expect, _electron as electron } from '@playwright/test';
import type { Page, ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

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

  electronApp: async ({ userDataDir, workspaceRoot }, use) => {
    // 写入 explorer.json,让 hydrate 自动设 root
    const explorerJson = {
      version: 1,
      workspace: {
        root: workspaceRoot,
        recentRoots: [workspaceRoot],
      },
      explorer: {
        activePath: null,
        expandedPaths: [workspaceRoot],
        sort: { by: 'name' as const, reverse: false },
      },
      pinned: { paths: [] },
    };
    writeFileSync(
      path.join(userDataDir, 'explorer.json'),
      JSON.stringify(explorerJson),
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ELECTRON_DISABLE_GPU: '1',
        CONTINUO_E2E: '1',
      },
    });
    await use(app);
    await app.close();
  },

  window: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },
});

export { expect };
