// 外部删除不关闭干净 tab(VSCode workbench.editor.closeOnFileDelete: false):git checkout 切到删除该文件的分支 →
// tab 保留并显示「(已删除)」,切回 → 标记清除、内容照旧;工作区根被改名 → 打开的 tab 显示已删除,改回 → 清除。
// 应用内保存过的文件 mv 走再 mv 回(mv 不改 mtime / size / ino,与保存记录一致)同样清除。
// 单元规范见 src/__tests__/editor-orphaned-tab/。
import { execFileSync } from 'node:child_process';
import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { editorTab, openWorkspaceFile } from './helpers/editor';

const DELETED = /[(（](Deleted|已删除|삭제됨)[)）]/;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

test('git checkout 切到删除该文件的分支 → 干净 tab 保留并显示已删除;切回 → 标记清除', async ({
  window,
  workspaceRoot,
}) => {
  git(workspaceRoot, 'init', '-q', '-b', 'main');
  git(workspaceRoot, 'add', '-A');
  git(workspaceRoot, 'commit', '-q', '-m', 'init');
  git(workspaceRoot, 'checkout', '-q', '-b', 'gone');
  git(workspaceRoot, 'rm', '-q', 'src/a.ts');
  git(workspaceRoot, 'commit', '-q', '-m', 'rm a');
  git(workspaceRoot, 'checkout', '-q', 'main');

  await waitForTestHooks(window);
  await openWorkspaceFile(window, ['src', 'a.ts']);
  const tab = editorTab(window, /a\.ts/);
  await expect(tab).toBeVisible();

  git(workspaceRoot, 'checkout', '-q', 'gone');
  await expect(tab).toContainText(DELETED, { timeout: 10_000 });
  await window.waitForTimeout(1_500); // 修复前约 0.5s 确认后关闭 tab:多等一会仍在
  await expect(tab).toBeVisible();
  await expect(tab.locator('.line-through')).toHaveText('a.ts');

  git(workspaceRoot, 'checkout', '-q', 'main');
  await expect(tab).not.toContainText(DELETED, { timeout: 10_000 });
  await expect(window.locator('.cm-content')).toContainText('export const a = 1;');
});

test('工作区根被外部改名 → 打开的 tab 都显示已删除;改回原名 → 标记清除', async ({
  window,
  workspaceRoot,
}) => {
  await waitForTestHooks(window);
  await openWorkspaceFile(window, ['README.md']);
  await openWorkspaceFile(window, ['src', 'a.ts']);
  const readme = editorTab(window, /README\.md/);
  const a = editorTab(window, /a\.ts/);

  const moved = `${workspaceRoot}-moved`;
  await rename(workspaceRoot, moved);
  try {
    await expect(readme).toContainText(DELETED, { timeout: 10_000 });
    await expect(a).toContainText(DELETED, { timeout: 10_000 });
  } finally {
    await rename(moved, workspaceRoot);
  }
  await expect(readme).not.toContainText(DELETED, { timeout: 10_000 });
  await expect(a).not.toContainText(DELETED, { timeout: 10_000 });
});

/** 在编辑器内追加一行并 ⌘S,等写盘完成(此后磁盘 stat 与保存记录一致)。 */
async function editAndSave(window: Page, file: string, marker: string): Promise<void> {
  const editor = window.locator('.cm-content').first();
  await editor.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type(`\n// ${marker}`);
  await window.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => readFile(file, 'utf8'), { timeout: 5_000 }).toContain(marker);
}

test('应用内保存后外部 mv 走 → 显示已删除;mv 回原位 → 标记清除', async ({ window, workspaceRoot }) => {
  await waitForTestHooks(window);
  await openWorkspaceFile(window, ['src', 'a.ts']);
  const tab = editorTab(window, /a\.ts/);
  const file = path.join(workspaceRoot, 'src', 'a.ts');
  await editAndSave(window, file, 'saved-before-mv');

  const away = path.join(workspaceRoot, 'a.ts.away');
  await rename(file, away);
  try {
    await expect(tab).toContainText(DELETED, { timeout: 10_000 });
  } finally {
    await rename(away, file);
  }
  // 修复前:回声判断(stat 与保存记录一致)跳过读盘,标记一直不清
  await expect(tab).not.toContainText(DELETED, { timeout: 10_000 });
  await expect(window.locator('.cm-content')).toContainText('saved-before-mv');
});

test('工作区根改名再改回 → 应用内保存过的 tab 与没保存过的 tab 都清除标记', async ({ window, workspaceRoot }) => {
  await waitForTestHooks(window);
  await openWorkspaceFile(window, ['README.md']);
  await openWorkspaceFile(window, ['src', 'a.ts']);
  const readme = editorTab(window, /README\.md/);
  const a = editorTab(window, /a\.ts/);
  await editAndSave(window, path.join(workspaceRoot, 'src', 'a.ts'), 'saved-before-root-mv');

  const moved = `${workspaceRoot}-moved`;
  await rename(workspaceRoot, moved);
  try {
    await expect(readme).toContainText(DELETED, { timeout: 10_000 });
    await expect(a).toContainText(DELETED, { timeout: 10_000 });
  } finally {
    await rename(moved, workspaceRoot);
  }
  await expect(readme).not.toContainText(DELETED, { timeout: 10_000 });
  await expect(a).not.toContainText(DELETED, { timeout: 10_000 });
});
