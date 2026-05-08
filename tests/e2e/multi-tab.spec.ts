// 多文件打开 → EditorHeader 切到 TabNav 模式;切 tab + 关 tab.
import { test, expect } from './fixtures/with-workspace';

async function openTwoFiles(window: import('@playwright/test').Page): Promise<void> {
  // 先打开 README.md(单 tab 紧凑模式)
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // 展开 src 目录(单击文件夹会 expand)
  await window.locator('text=src').first().click();

  // 打开 src/a.ts(此后 tabs.length=2,EditorHeader 切到 TabNav 模式)
  await window.locator('text=a.ts').first().click();
  // 等 tablist 出现
  await expect(window.locator('[role=tablist]').first()).toBeVisible({
    timeout: 10_000,
  });
}

test('打开 2 个文件 → TabNav 显示两个 tab', async ({ window }) => {
  await openTwoFiles(window);

  const tablist = window.locator('[role=tablist]').first();
  await expect(tablist).toContainText('README.md');
  await expect(tablist).toContainText('a.ts');
});

test('点击 tab → 切换 active', async ({ window }) => {
  await openTwoFiles(window);

  // 切回 README.md tab
  await window
    .locator('[role=tablist]')
    .first()
    .getByText('README.md', { exact: false })
    .click();

  // StatusBar 文件名同步
  await expect(window.locator('footer')).toContainText('README.md');
});
