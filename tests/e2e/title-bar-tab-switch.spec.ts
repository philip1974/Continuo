// 切 tab → TitleBar 文本同步 active filename + tooltip path.
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('开 README.md + a.ts → 切 tab → TitleBar 同步', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md');

  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts');

  // tooltip 同步 active filePath
  const titleSpan = window.locator('header').first().locator('span[title]');
  await expect(titleSpan).toHaveAttribute(
    'title',
    path.join(workspaceRoot, 'src/a.ts'),
  );

  // 切回 README.md tab
  const readmeTab = window
    .locator('main [role=tablist]')
    .first()
    .locator('[role=tab]')
    .filter({ hasText: 'README.md' });
  await readmeTab.click();

  await expect(window.locator('header').first()).toContainText('README.md');
  await expect(titleSpan).toHaveAttribute(
    'title',
    path.join(workspaceRoot, 'README.md'),
  );
});
