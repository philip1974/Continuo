// 编辑器 mode 是 store 全局状态;切换 tab 后,回到原 tab,mode 仍是上次值.
import { test, expect } from './fixtures/with-workspace';

test('README.md → Source → 切到 a.ts → 切回 README.md → 仍 Source', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // 切 Source mode
  const sourceBtn = window
    .locator('main')
    .locator('button')
    .filter({ hasText: /^Source$/ })
    .first();
  await sourceBtn.click();
  await expect(sourceBtn).toHaveAttribute('data-active', 'true');

  // 打开 a.ts(.ts 文件无 segmented control)
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts');

  // 回 README.md tab
  const readmeTab = window
    .locator('main [role=tablist]')
    .first()
    .locator('[role=tab]')
    .filter({ hasText: 'README.md' });
  await readmeTab.click();
  await expect(window.locator('header').first()).toContainText('README.md');

  // mode 仍 Source(全局)
  const sourceBtn2 = window
    .locator('main')
    .locator('button')
    .filter({ hasText: /^Source$/ })
    .first();
  await expect(sourceBtn2).toHaveAttribute('data-active', 'true');
});
