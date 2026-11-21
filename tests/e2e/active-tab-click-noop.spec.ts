// 点 active tab(已经 selected)→ 视为 noop,store activeTabId 不变.
import { test, expect } from './fixtures/with-workspace';

const EDITOR_TABS = /^(编辑器标签|Editor tabs|편집기 탭)$/;

test('单击当前 active 文件 → tab 仍唯一 + 不重复创建', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  const editorTabs = window.getByRole('tablist', { name: EDITOR_TABS });
  const readmeTab = editorTabs.getByRole('tab', { name: 'README.md' });
  await expect(readmeTab).toHaveCount(1);

  // 再点 README.md → switch 到现有 tab(本就是 active)
  await window.locator('text=README.md').first().click();

  // 仍是同一个文件 tab,不重复创建
  await expect(readmeTab).toHaveCount(1);
  // header 仍 README.md
  await expect(window.locator('header').first()).toContainText('README.md');
});
