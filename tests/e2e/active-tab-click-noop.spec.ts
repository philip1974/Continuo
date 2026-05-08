// 点 active tab(已经 selected)→ 视为 noop,store activeTabId 不变.
import { test, expect } from './fixtures/with-workspace';

test('单击当前 active 文件 → tab 仍唯一 + 不重复创建', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // 紧凑模式 1 tab(无 tablist)
  await expect(window.locator('main [role=tablist]')).toHaveCount(0);

  // 再点 README.md → switch 到现有 tab(本就是 active)
  await window.locator('text=README.md').first().click();

  // 仍是 1 tab,无 tablist
  await expect(window.locator('main [role=tablist]')).toHaveCount(0);
  // header 仍 README.md
  await expect(window.locator('header').first()).toContainText('README.md');
});
