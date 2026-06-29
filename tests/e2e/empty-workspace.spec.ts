// 无工作区时 Explorer 渲染 EmptyWorkspace 的「打开文件夹」按钮.
import { test, expect } from './fixtures/electron-app';
import { DOCK_EMPTY_MESSAGE, EDITOR_NO_FILE_OPEN_TEXT } from './helpers/editor';
import {
  EXPLORER_NO_FOLDER_OPEN_TEXT,
  EXPLORER_OPEN_FOLDER,
} from './helpers/explorer';

test('Explorer 显示「打开文件夹」按钮 + 「未打开文件夹」标签', async ({ window }) => {
  // ExplorerSidebar 内容 = <Explorer /> 在无 root 时是 EmptyWorkspace
  const explorerArea = window.locator('main aside').nth(1);
  await expect(explorerArea).toBeVisible();
  await expect(explorerArea).toContainText(EXPLORER_NO_FOLDER_OPEN_TEXT);

  const openBtn = explorerArea.getByRole('button', {
    name: EXPLORER_OPEN_FOLDER,
  });
  await expect(openBtn).toBeVisible();
  await expect(openBtn).toBeEnabled();
});

test('Editor 区显示 EditorWelcome / EmptyState 占位之一', async ({ window }) => {
  // 启动时还没打开 tab;dock 中 editor panel 显示 EditorWelcome 「未打开文件」
  // 或 dock 全空显示 EmptyState 「所有面板都关掉了」
  const body = window.locator('body');
  await expect(body).toContainText(
    new RegExp(
      `${EDITOR_NO_FILE_OPEN_TEXT.source}|${DOCK_EMPTY_MESSAGE.source}`,
    ),
    { timeout: 10_000 },
  );
});
