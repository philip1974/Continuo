// dirty tab 外部 writeFile → 不被覆盖,内部 dirty 内容仍在.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_UNSAVED_CHANGES_SELECTOR } from './helpers/editor';

test('a.ts dirty → 外部 writeFile → CM 仍显内部修改 + 仍 dirty', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });

  // 内部输入 → dirty
  await cm.click();
  await window.keyboard.type(' // mine');
  await expect(cm).toContainText('mine');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible();

  // 外部 writeFile,本应推 fs:dir-changed
  await writeFile(
    path.join(workspaceRoot, 'src/a.ts'),
    'export const a = 999; // ext\n',
  );

  // 等一段(给 watch + dispatch 时间)
  await window.waitForTimeout(2_000);

  // CM 仍显 'mine'(内部修改未被外部覆盖)
  await expect(cm).toContainText('mine');
  // dirty 仍在
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible();
});
