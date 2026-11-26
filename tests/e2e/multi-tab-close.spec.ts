import {
  EDITOR_CLOSE_README_MD,
  EDITOR_NO_FILE_OPEN,
  EDITOR_TABS,
} from './helpers/editor';
// 多 tab 时点 tab close × → 该 tab 移除;单 tab 也是 TabNav(仍有 tablist).
import { test, expect } from './fixtures/with-workspace';

test('开 2 tab → 关其中一个 → 只剩 1 个 tab', async ({
  window,
}) => {
  // 开 README.md
  await window.locator('text=README.md').first().dblclick();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // 展开 src + 开 a.ts → 两个 tab
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().dblclick();
  await expect(
    window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab'),
  ).toHaveCount(2, { timeout: 10_000 });

  // TabNavItem close button 的可访问名由 basename 生成(见 helpers 的锚定正则).
  const closeReadme = window.getByRole('button', {
    name: EDITOR_CLOSE_README_MD,
  });
  await expect(closeReadme).toBeVisible();
  await closeReadme.click();

  // 只剩 1 个 editor tab.
  const editorTabs = window
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByRole('tab');
  await expect(editorTabs).toHaveCount(1, {
    timeout: 5_000,
  });
  // header 显示剩下的 a.ts
  await expect(window.locator('header').first()).toContainText('a.ts');
});

test('单 tab 的 close × → 回 EditorWelcome', async ({ window }) => {
  await window.locator('text=README.md').first().dblclick();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // 单 tab 也是 TabNavItem,关闭按钮可访问名由 basename 生成
  await window.getByRole('button', { name: EDITOR_CLOSE_README_MD }).click();

  // EditorWelcome 出现
  await expect(window.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible({
    timeout: 5_000,
  });
});
