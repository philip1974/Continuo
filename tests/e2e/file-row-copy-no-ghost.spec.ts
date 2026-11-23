// 复制(非剪切)→ row 不应 opacity-50.
import { test, expect } from './fixtures/with-workspace';

const COPY = /^(复制|Copy|복사)$/;
const PASTE = /^(粘贴|Paste|붙여넣기)$/;

test('复制 README.md → row 无 opacity-50 ghost', async ({ window }) => {
  const readmeRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: /^README\.md$/ })
    .first();
  await expect(readmeRow).toBeVisible();

  await readmeRow.click({ button: 'right' });
  await window.getByRole('menuitem', { name: COPY }).click();

  // 复制确已执行:右键 src 出现「粘贴」(剪贴板为空时不显示)
  await window.locator('text=src').first().click({ button: 'right' });
  await expect(window.getByRole('menu').last().getByRole('menuitem', { name: PASTE })).toBeVisible();
  await window.keyboard.press('Escape');

  // 验 row 仍无 opacity-50
  const cls = (await readmeRow.getAttribute('class')) ?? '';
  expect(cls).not.toContain('opacity-50');
});
