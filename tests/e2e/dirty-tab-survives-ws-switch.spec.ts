// dirty ws1/a.ts + 切 ws2 → tab 强行关闭(closeTabsOutsideRoot 不弹 confirm).
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('dirty ws1/a.ts + 切 ws2 → tab 关 + EditorWelcome', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-dws-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-dws-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-dws-ws2-'));
  try {
    mkdirSync(path.join(ws1, 'src'), { recursive: true });
    writeFileSync(path.join(ws1, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(ws2, 'README.md'), '# 2\n');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws1, recentRoots: [ws1, ws2] },
        explorer: {
          activePath: null,
          expandedPaths: [ws1, path.join(ws1, 'src')],
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

    await win.locator('text=src').first().click();
    await win.locator('text=a.ts').first().click();
    const cm = win.locator('.cm-content');
    await expect(cm).toBeVisible({ timeout: 10_000 });
    await cm.click();
    await win.keyboard.type(' // dirty');
    await expect(win.locator('span[aria-label="未保存修改"]')).toBeVisible();

    // 切 ws2
    await win.locator('button[aria-label=更多操作]').click();
    const ws2Name = path.basename(ws2);
    await win
      .getByRole('menu')
      .getByRole('menuitem', { name: ws2Name, exact: false })
      .click();

    // tab 强关 → EditorWelcome
    await expect(win.getByText('未打开文件').first()).toBeVisible({
      timeout: 5_000,
    });

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
