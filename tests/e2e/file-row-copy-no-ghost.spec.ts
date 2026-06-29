// 复制(非剪切)→ row 不应 opacity-50.
import { test, expect } from './fixtures/with-workspace';

const COPY = /^(复制|Copy|복사)$/;

test('复制 README.md → row 无 opacity-50 ghost', async ({ window }) => {
  const readmeRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: /^README\.md$/ })
    .first();
  await expect(readmeRow).toBeVisible();

  await readmeRow.click({ button: 'right' });
  await window.getByRole('menuitem', { name: COPY }).click();

  // 等一段 + 验 row 仍无 opacity-50
  await window.waitForTimeout(200);
  const cls = (await readmeRow.getAttribute('class')) ?? '';
  expect(cls).not.toContain('opacity-50');
});
