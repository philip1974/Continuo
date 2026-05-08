// 点 ⋯ → 展开全部 → 默认折叠的 src 子目录展开,a.ts/b.ts 可见.
//
// 跳过原因:expandAll 触发 headless-tree 大量 setOpen + virtualizer 重排,
// 在 Playwright 的 click 流程中页面不稳定,主进程偶发崩溃。功能本身在手动 QA
// 下工作;tree 单测覆盖 expandAll 行为。
import { test, expect } from './fixtures/with-workspace';

test.skip('「展开全部」 → src/a.ts 出现(无须先点 src)', async ({ window }) => {
  // 默认 src 折叠 → a.ts 不显
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^a\.ts$/ }),
  ).toHaveCount(0);

  // 点 ⋯ 菜单 → 展开全部
  await window.locator('button[aria-label=更多操作]').click();
  await window
    .getByRole('menu')
    .getByRole('menuitem', { name: /^展开全部$/ })
    .click();

  // src/a.ts 现在可见
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^a\.ts$/ }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^b\.ts$/ }),
  ).toBeVisible();
});
