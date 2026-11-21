// 多文件打开 → EditorHeader 切到 TabNav 模式;切 tab + 关 tab.
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS, openWorkspaceFile } from './helpers/editor';

async function openTwoFiles(window: import('@playwright/test').Page): Promise<void> {
  await openWorkspaceFile(window, ['README.md']);
  await openWorkspaceFile(window, ['src', 'a.ts']);
  // 等 tablist 出现
  await expect(window.getByRole('tablist', { name: EDITOR_TABS })).toBeVisible({
    timeout: 10_000,
  });
}

test('打开 2 个文件 → TabNav 显示两个 tab', async ({ window }) => {
  await openTwoFiles(window);

  const tablist = window.getByRole('tablist', { name: EDITOR_TABS });
  await expect(tablist).toContainText('README.md');
  await expect(tablist).toContainText('a.ts');
});

test('点击 tab → 切换 active', async ({ window }) => {
  await openTwoFiles(window);

  // 切回 README.md tab
  await window
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByText('README.md', { exact: false })
    .click();

  // StatusBar 文件名同步
  await expect(window.locator('footer')).toContainText('README.md');
});
