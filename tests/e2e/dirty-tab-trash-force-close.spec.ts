// 改 a.ts dirty → 右键 trash → 文件被删 + dirty tab 保留.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_UNSAVED_CHANGES_SELECTOR } from './helpers/editor';
import { EXPLORER_TRASH } from './helpers/explorer';

test('dirty a.ts → trash → dirty tab 保留 + 文件被删', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty-trash');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible();

  // 右键 a.ts → 移到废纸篓
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^a\.ts$/ })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_TRASH }).click();

  // dirty tab 保留,避免删除文件时静默丢失未保存编辑.
  await expect(window.locator('header').first()).toContainText('a.ts ●', {
    timeout: 5_000,
  });
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible();
  // 文件被删
  await expect(async () => {
    const exists = await stat(path.join(workspaceRoot, 'src/a.ts'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  }).toPass({ timeout: 5_000 });
});
