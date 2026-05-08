// 无工作区时 Explorer 渲染 EmptyWorkspace 的「打开文件夹」按钮.
import { test, expect } from './fixtures/electron-app';

test('Explorer 显示「打开文件夹」按钮 + 「未打开文件夹」标签', async ({ window }) => {
  // ExplorerSidebar 内容 = <Explorer /> 在无 root 时是 EmptyWorkspace
  const explorerArea = window.locator('main aside').nth(1);
  await expect(explorerArea).toBeVisible();
  await expect(explorerArea).toContainText('未打开文件夹');

  const openBtn = explorerArea.locator('button', { hasText: '打开文件夹' });
  await expect(openBtn).toBeVisible();
  await expect(openBtn).toBeEnabled();
});

test('Editor 区显示 EditorWelcome / EmptyState 占位之一', async ({ window }) => {
  // 启动时还没打开 tab;dock 中 editor panel 显示 EditorWelcome 「未打开文件」
  // 或 dock 全空显示 EmptyState 「所有面板都关掉了」
  const body = window.locator('body');
  const text = await body.textContent();
  expect(
    text?.includes('未打开文件') || text?.includes('所有面板都关掉了'),
  ).toBe(true);
});
