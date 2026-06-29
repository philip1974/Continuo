// 同文件 open 二次 → 不会创建第二个 tab(switchTab 即可).
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS, openWorkspaceFile } from './helpers/editor';

test('单击 README.md → 切到 src/a.ts → 单击 README.md 仍只 1+1=2 个 tab(不重复)', async ({
  window,
}) => {
  // 第一次 open README.md
  await openWorkspaceFile(window, ['README.md']);

  // 展开 src + 打开 a.ts
  await openWorkspaceFile(window, ['src', 'a.ts']);
  // 此时 2 个 tab
  const tablist = window.getByRole('tablist', { name: EDITOR_TABS });
  await expect(tablist).toBeVisible();
  let tabs = tablist.locator('[role=tab]');
  await expect(tabs).toHaveCount(2);

  // 第二次 click README.md → 不应创建新 tab,switchTab 切到现有
  await openWorkspaceFile(window, ['README.md']);
  tabs = tablist.locator('[role=tab]');
  await expect(tabs).toHaveCount(2);

  // active 切到 README.md(StatusBar 显示 README.md)
  await expect(window.locator('footer')).toContainText('README.md');
});
