// TitleBar 的 title 属性 tooltip:无 active = root 路径;有 active = filePath.
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('无 active tab → TitleBar 文本「workspace」+ tooltip = root', async ({
  window,
  workspaceRoot,
}) => {
  const wsName = path.basename(workspaceRoot);
  const titleSpan = window.locator('header').first().locator('span[title]');
  await expect(titleSpan).toHaveText(wsName, { timeout: 10_000 });
  await expect(titleSpan).toHaveAttribute('title', workspaceRoot);
});

test('打开 README.md → TitleBar tooltip = filePath', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  const titleSpan = window.locator('header').first().locator('span[title]');
  await expect(titleSpan).toHaveAttribute(
    'title',
    path.join(workspaceRoot, 'README.md'),
  );
});
