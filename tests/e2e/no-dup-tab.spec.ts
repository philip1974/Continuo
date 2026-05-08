// 同文件 open 二次 → 不会创建第二个 tab(switchTab 即可).
import { test, expect } from './fixtures/with-workspace';

test('单击 README.md → 切到 src/a.ts → 单击 README.md 仍只 1+1=2 个 tab(不重复)', async ({
  window,
}) => {
  // 第一次 open README.md
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // 展开 src + 打开 a.ts
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  // 此时 2 个 tab
  await expect(window.locator('main [role=tablist]').first()).toBeVisible();
  let tabs = window.locator('main [role=tablist]').first().locator('[role=tab]');
  await expect(tabs).toHaveCount(2);

  // 第二次 click README.md → 不应创建新 tab,switchTab 切到现有
  await window.locator('text=README.md').first().click();
  tabs = window.locator('main [role=tablist]').first().locator('[role=tab]');
  await expect(tabs).toHaveCount(2);

  // active 切到 README.md(StatusBar 显示 README.md)
  await expect(window.locator('footer')).toContainText('README.md');
});
