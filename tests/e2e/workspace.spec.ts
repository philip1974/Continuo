// 预置 workspace 后的 Explorer + Quick Open 流程.
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test('hydrate 后 Explorer 显示 workspace 名 + 文件树', async ({
  window,
  workspaceRoot,
}) => {
  const wsName = path.basename(workspaceRoot);

  // ExplorerHeader 渲染 workspace basename(CSS uppercase,实际文本未变)
  await expect(
    window.locator('main aside').nth(1).getByText(wsName).first(),
  ).toBeVisible({ timeout: 10_000 });

  // FolderTree 渲染至少一个 row(README.md / src)
  await expect(window.locator('text=README.md')).toBeVisible();
  await expect(window.locator('text=src').first()).toBeVisible();
});

test('Status Bar 显示 workspace basename + main 占位', async ({
  window,
  workspaceRoot,
}) => {
  const wsName = path.basename(workspaceRoot);
  const status = window.locator('footer');
  await expect(status).toContainText(wsName);
  await expect(status).toContainText('main');
});

test('Ctrl+P Quick Open 列出 workspace 文件', async ({ window }) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();

  // walk 完成后列表里应有 README.md 与 src/a.ts
  await expect(window.locator('.wm-modal-content')).toContainText(
    'README.md',
    { timeout: 10_000 },
  );

  // 输入过滤
  await input.fill('a.ts');
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts');
  await expect(window.locator('.wm-modal-content')).not.toContainText(
    'README.md',
  );

  await window.keyboard.press('Escape');
});

test('TitleBar 显示 workspace basename', async ({ window, workspaceRoot }) => {
  const wsName = path.basename(workspaceRoot);
  await expect(window.locator('header').first()).toContainText(wsName);
});
