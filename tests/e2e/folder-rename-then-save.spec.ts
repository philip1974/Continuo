// dirty + folder rename + Cmd+S → 写新路径.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('dirty src/a.ts → rename src → lib → Cmd+S → lib/a.ts 落盘新内容', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // post-rename');

  // rename src → lib
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: 'src' })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^重命名/ }).click();
  const input = window.locator('input:focus');
  await input.press('ControlOrMeta+KeyA');
  await input.fill('lib');
  await input.press('Enter');

  // Cmd+S
  await cm.press('ControlOrMeta+KeyS');

  await expect(async () => {
    const content = await readFile(
      path.join(workspaceRoot, 'lib/a.ts'),
      'utf8',
    );
    expect(content).toContain('post-rename');
  }).toPass({ timeout: 5_000 });
});
