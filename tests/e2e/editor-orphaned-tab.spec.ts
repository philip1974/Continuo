// 删除有未保存修改的 .md(Explorer 删除 / 外部删除):tab 保留并显示「(已删除)」+ 删除线,自动保存延迟过后文件也不被写回;
// 手动保存(⌘S)按路径重建文件(VSCode 同款)。单元规范见 src/__tests__/editor-orphaned-tab/。
import { stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { EXPLORER_TRASH, confirmExplorerTrash } from './helpers/explorer';
import { editorTab } from './helpers/editor';

const DELETED = /[(（](Deleted|已删除|삭제됨)[)）]/;
const UNSAVED_WARNING = /(unsaved changes|未保存的更改|저장되지 않은 변경 내용)/;

const exists = (p: string): Promise<boolean> =>
  stat(p)
    .then(() => true)
    .catch(() => false);

async function openReadmeAndEdit(window: import('@playwright/test').Page): Promise<void> {
  await waitForTestHooks(window);
  // 自动保存用默认延迟(2s):编辑后立即删除,删除落在延迟窗口内 —— 修复前到点会把文件写回。
  await window.locator('[role=treeitem]').filter({ hasText: /^README\.md$/ }).first().click();
  await expect(window.locator('header').first()).toContainText('README.md', { timeout: 10_000 });
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.setEditorContent(t.getEditorActiveTabId() as string, '# unsaved edit\n');
  });
}

test('Explorer 删除编辑过的 .md:确认框有未保存警告;tab 显示已删除,2 秒后文件不被写回;⌘S 重建', async ({
  window,
  workspaceRoot,
}) => {
  const file = path.join(workspaceRoot, 'README.md');
  await openReadmeAndEdit(window);
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^README\.md$/ })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_TRASH }).click();
  await expect(window.getByRole('dialog')).toContainText(UNSAVED_WARNING);
  await confirmExplorerTrash(window);

  const tab = editorTab(window, /README\.md/);
  await expect(tab).toContainText(DELETED, { timeout: 5_000 });
  await expect(tab.locator('.line-through')).toHaveText('README.md');
  await expect(async () => expect(await exists(file)).toBe(false)).toPass({ timeout: 5_000 });
  await window.waitForTimeout(3_000); // > 自动保存延迟
  expect(await exists(file)).toBe(false);

  await window.keyboard.press('ControlOrMeta+s');
  await expect(async () => expect(await exists(file)).toBe(true)).toPass({ timeout: 5_000 });
  await expect(tab).not.toContainText(DELETED);
});

test('外部删除编辑过的 .md:tab 显示已删除,2 秒后文件不被写回', async ({ window, workspaceRoot }) => {
  const file = path.join(workspaceRoot, 'README.md');
  await openReadmeAndEdit(window);
  await unlink(file);
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.setEditorContent(t.getEditorActiveTabId() as string, '# still editing\n');
  });
  const tab = editorTab(window, /README\.md/);
  await expect(tab).toContainText(DELETED, { timeout: 10_000 });
  await window.waitForTimeout(3_000); // > 自动保存延迟
  expect(await exists(file)).toBe(false);
});
