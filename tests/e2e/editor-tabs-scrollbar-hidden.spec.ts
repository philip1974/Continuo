// 编辑器 tab 栏不显示原生滚动条(溢出时横向滚动 + 两侧渐隐提示):tablist 的 [scrollbar-width:none] utility 须真正生效 ——
// 全局滚动条默认在 @layer base,不再以未分层规则压过 utility(此前计算值为 thin,悬停时滚动条压在 tab 文字上)。
// 其它滚动区域仍是全局默认 thin。BDD: src/__tests__/design-system/(样式契约「全局滚动条规则」)
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { EDITOR_TABS, openWorkspaceFile } from './helpers/editor';

test('编辑器 tablist 计算值 scrollbar-width 为 none;普通元素仍为全局默认 thin', async ({ window }) => {
  await waitForTestHooks(window);
  await openWorkspaceFile(window, ['README.md']);
  const tablist = window.getByRole('tablist', { name: EDITOR_TABS });
  await expect(tablist).toBeVisible({ timeout: 10_000 });
  expect(await tablist.evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe('none');
  expect(await window.evaluate(() => getComputedStyle(document.body).scrollbarWidth)).toBe('thin');
});
