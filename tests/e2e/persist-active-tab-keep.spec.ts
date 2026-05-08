// Editor active tab 在 dock layout panel 关 + 重开后 → 不持久(editor.tabs 不入 layout).
// 但 dock layout(panel id 集合)持久化 → editor panel 仍在.
//
// 这条测验证「关 Editor panel + 重启 → editor.tabs=[] 但 dock 还原 + EmptyState」.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('关 Editor panel → 重启 → EmptyState(layout 记忆 0 panel)', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-empty-after-'));
  try {
    const app1 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    // 关 Editor
    await win1.locator('button[aria-label="Close Editor"]').click();
    await win1.waitForTimeout(400);
    await expect(
      win1.locator('[data-testid="empty-state"]'),
    ).toBeVisible({ timeout: 5_000 });

    // 等 layout-persist debounce
    await win1.waitForTimeout(600);
    await app1.close();

    // 重启
    const app2 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    // 仍 EmptyState
    await expect(
      win2.locator('[data-testid="empty-state"]'),
    ).toBeVisible({ timeout: 10_000 });

    await app2.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});
