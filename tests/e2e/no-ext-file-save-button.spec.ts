// 无扩展名 file (LICENSE) → 视为代码 → 不显保存按钮 + 不显 SegmentedControl.
import { _electron as electron, expect, test } from '@playwright/test';
import { EDITOR_MODE_EDIT, EDITOR_SAVE_LABEL } from './helpers/editor';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('LICENSE 无扩展名 → 不显示「保存」按钮', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-noext-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-noext-ws-'));
  try {
    writeFileSync(path.join(ws, 'LICENSE'), 'MIT');
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

    await win.locator('text=LICENSE').first().click();
    await expect(win.locator('header').first()).toContainText('LICENSE', {
      timeout: 10_000,
    });

    // Save 按钮不显
    const main = win.locator('main');
    await expect(
      win.getByRole('button', { name: EDITOR_SAVE_LABEL }),
    ).toHaveCount(0);

    // SegmentedControl(Edit/Source/Preview) 不显
    expect(
      await main.locator('button').filter({ hasText: EDITOR_MODE_EDIT }).count(),
    ).toBe(0);

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
