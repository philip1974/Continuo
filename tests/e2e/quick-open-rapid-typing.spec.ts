// 快速 fill 不同 query → 列表稳定收敛于最后值.  @edge
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test('Cmd+P fill a → fill ab → fill abc → 列表反映 abc', async ({ window }) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', {
    timeout: 10_000,
  });

  await input.fill('a');
  await input.fill('ab');
  await input.fill('abc'); // 不存在
  // 列表收敛到 'abc' 的过滤结果:无匹配项,显示「无匹配文件」
  await expect(window.locator('.wm-modal-content li')).toHaveCount(0, { timeout: 5_000 });
  await expect(window.getByText(/^(无匹配文件|No matching files|일치하는 파일 없음)$/)).toBeVisible();
});
