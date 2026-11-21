// 剪切文件 → FileRow 加 opacity-50 类 (ghost visual).
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_CUT } from './helpers/explorer';

test('右键 README.md 剪切 → row 显 opacity-50', async ({ window }) => {
  const readmeRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: /^README\.md$/ })
    .first();
  await expect(readmeRow).toBeVisible();

  // 默认无 opacity-50
  const beforeClass = (await readmeRow.getAttribute('class')) ?? '';
  expect(beforeClass).not.toContain('opacity-50');

  // 剪切
  await readmeRow.click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_CUT }).click();

  // 等渲 → row 现在含 opacity-50
  await expect(async () => {
    const after = (await readmeRow.getAttribute('class')) ?? '';
    expect(after).toContain('opacity-50');
  }).toPass({ timeout: 5_000 });
});
