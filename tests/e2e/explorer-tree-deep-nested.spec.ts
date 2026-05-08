// 深层目录展开:src/sub1/sub2/leaf.ts → 逐级展开 + 可单击打开.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('深 3 层目录:逐级展开 + 打开 leaf.ts', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-deep-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-deep-ws-'));
  try {
    mkdirSync(path.join(ws, 'src/sub1/sub2'), { recursive: true });
    writeFileSync(
      path.join(ws, 'src/sub1/sub2/leaf.ts'),
      'export const leaf = true;\n',
    );
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws, recentRoots: [ws] },
        explorer: {
          activePath: null,
          expandedPaths: [ws],
          sort: { by: 'name', reverse: false },
        },
        pinned: { paths: [] },
      }),
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 单击 src 展开
    await win.locator('text=src').first().click();
    await expect(win.locator('text=sub1').first()).toBeVisible({
      timeout: 10_000,
    });
    // 单击 sub1
    await win.locator('text=sub1').first().click();
    await expect(win.locator('text=sub2').first()).toBeVisible({
      timeout: 10_000,
    });
    // 单击 sub2
    await win.locator('text=sub2').first().click();
    await expect(win.locator('text=leaf.ts').first()).toBeVisible({
      timeout: 10_000,
    });

    // 单击 leaf.ts → editor 打开
    await win.locator('text=leaf.ts').first().click();
    await expect(win.locator('header').first()).toContainText('leaf.ts', {
      timeout: 10_000,
    });

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
