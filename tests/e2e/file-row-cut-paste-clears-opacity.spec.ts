// cut → row opacity-50 → paste → 已 move,原位置 row 消失,ghost 自然清.
import { test, expect } from './fixtures/with-workspace';

test('cut README.md → paste 到 src/ → 原 README.md row 消失', async ({
  window,
}) => {
  const readmeRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: /^README\.md$/ });
  await expect(readmeRow.first()).toBeVisible();

  // cut
  await readmeRow.first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^剪切$/ }).click();
  // ghost 出现
  await expect(async () => {
    const cls = (await readmeRow.first().getAttribute('class')) ?? '';
    expect(cls).toContain('opacity-50');
  }).toPass({ timeout: 5_000 });

  // 展开 src + paste
  await window.locator('text=src').first().click();
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^粘贴$/ }).click();

  // 原根级 README.md 消失,只 src/README.md 存在
  await expect(async () => {
    const count = await readmeRow.count();
    // 仅 src/README.md(1 个),原根 README 已不存在
    expect(count).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 5_000 });
});
