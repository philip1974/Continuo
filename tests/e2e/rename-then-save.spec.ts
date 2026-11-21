// 修改 a.ts dirty → rename → renamed.ts → Cmd+S → 内容写到 renamed.ts.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_RENAME } from './helpers/explorer';

test('dirty + rename → Cmd+S → 新文件落盘新内容', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();

  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // saved-after-rename');

  // rename
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^a\.ts$/ })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_RENAME }).click();
  const input = window.locator('input:focus');
  await input.press('ControlOrMeta+KeyA');
  await input.fill('renamed.ts');
  await input.press('Enter');

  await expect(window.locator('header').first()).toContainText('renamed.ts', {
    timeout: 5_000,
  });

  // Cmd+S 写
  await cm.press('ControlOrMeta+KeyS');

  await expect(async () => {
    const content = await readFile(
      path.join(workspaceRoot, 'src/renamed.ts'),
      'utf8',
    );
    expect(content).toContain('saved-after-rename');
  }).toPass({ timeout: 5_000 });
});
