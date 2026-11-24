// 保存遇磁盘冲突 →「放弃更改并重新加载」:tab 换成磁盘版本、不再脏,磁盘不被覆盖。单元规范见 src/__tests__/editor-revert-file/。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_UNSAVED_CHANGES_SELECTOR } from './helpers/editor';

const REVERT = /^(放弃更改并重新加载|Discard Changes and Reload|변경 내용 취소 후 다시 로드)$/;

test('改脏 a.ts → 外部改盘 → ⌘S 冲突 → 放弃更改并重新加载', async ({ window, workspaceRoot }) => {
  const file = path.join(workspaceRoot, 'src/a.ts');
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // mine');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible({ timeout: 5_000 });

  const THEIRS = 'export const theirs = 1;\n';
  await writeFile(file, THEIRS);
  await window.keyboard.press('ControlOrMeta+s');
  const dialog = window.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await dialog.getByRole('button', { name: REVERT }).click();
  await expect(dialog).toBeHidden();

  await expect(cm).toContainText('export const theirs = 1;', { timeout: 5_000 });
  await expect(cm).not.toContainText('// mine');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(0);
  expect(await readFile(file, 'utf8')).toBe(THEIRS);
});
