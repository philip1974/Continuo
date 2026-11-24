// Explorer 键盘删除(对齐 VSCode):
//   - 未显示隐藏文件时,方向键 / Home 不会把焦点落到看不见的 . 开头项,Delete 删不到 .env / .github
//   - 删除先弹确认(explorer.confirmDelete 默认开),初始焦点在「取消」:直接回车 = 取消,不删
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { confirmExplorerTrash, explorerTreeItem } from './helpers/explorer';

const rowOf = (window: import('@playwright/test').Page, p: string) =>
  window.locator(`[role=treeitem][title="${p}"]`);

const exists = (p: string): Promise<boolean> =>
  stat(p)
    .then(() => true)
    .catch(() => false);

test('隐藏文件存在时:首个可见项上按 ↑ / Home 再 Delete → 只删可见项,.env / .github 保留', async ({
  window,
  workspaceRoot,
}) => {
  await mkdir(path.join(workspaceRoot, '.github'));
  await writeFile(path.join(workspaceRoot, '.github/ci.yml'), 'on: push\n');
  await writeFile(path.join(workspaceRoot, '.env'), 'SECRET=1\n');
  await writeFile(path.join(workspaceRoot, 'marker.txt'), 'marker');
  // 普通文件出现 = 树已按这批变更刷新
  await expect(explorerTreeItem(window, /^marker\.txt$/)).toBeVisible({ timeout: 10_000 });

  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await src.click(); // 展开 + 焦点(src 是首个可见项;.github 排在它前面但不显示)
  await expect(src).toBeFocused();
  await src.press('ArrowUp');
  await src.press('Home');
  await expect(src).toBeFocused();
  await expect(src).toHaveAttribute('aria-selected', 'true');

  await src.press('Delete');
  const dialog = window.getByRole('dialog');
  await expect(dialog).toContainText('src');
  await confirmExplorerTrash(window);

  await expect(async () => {
    expect(await exists(path.join(workspaceRoot, 'src'))).toBe(false);
  }).toPass({ timeout: 5_000 });
  expect(await exists(path.join(workspaceRoot, '.env'))).toBe(true);
  expect(await exists(path.join(workspaceRoot, '.github'))).toBe(true);
});

test('Delete 弹确认,初始焦点在「取消」:直接回车 → 关闭确认框,不删除', async ({
  window,
  workspaceRoot,
}) => {
  const readme = rowOf(window, path.join(workspaceRoot, 'README.md'));
  const src = rowOf(window, path.join(workspaceRoot, 'src'));
  await expect(src).toBeVisible({ timeout: 10_000 });
  await src.click();
  await src.press('ArrowDown'); // a.ts(src 已展开)
  await window.keyboard.press('End'); // README.md
  await expect(readme).toBeFocused();

  await readme.press('Delete');
  const dialog = window.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await expect(dialog).toContainText('README.md');
  await expect(dialog.getByRole('button', { name: /^(取消|Cancel|취소)$/ })).toBeFocused();
  await window.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  expect(await exists(path.join(workspaceRoot, 'README.md'))).toBe(true);
  // 焦点回到原行,选中未动
  await expect(readme).toBeFocused();
  await expect(readme).toHaveAttribute('aria-selected', 'true');
});
