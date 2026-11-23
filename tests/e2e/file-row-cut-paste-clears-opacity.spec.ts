// cut → row opacity-50 → paste → 已 move,原位置 row 消失,ghost 自然清.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

const CUT = /^(剪切|Cut|잘라내기)$/;
const PASTE = /^(粘贴|Paste|붙여넣기)$/;

test('cut README.md → paste 到 src/ → 原 README.md row 消失', async ({
  window,
  workspaceRoot,
}) => {
  const readmeRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: /^README\.md$/ });
  await expect(readmeRow.first()).toBeVisible();

  // cut
  await readmeRow.first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: CUT }).click();
  // ghost 出现
  await expect(async () => {
    const cls = (await readmeRow.first().getAttribute('class')) ?? '';
    expect(cls).toContain('opacity-50');
  }).toPass({ timeout: 5_000 });

  // 展开 src + paste
  await window.locator('text=src').first().click();
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: PASTE }).click();

  // 原根级 README.md 行消失(行 title 是完整路径),文件已移到 src/
  const rootReadme = path.join(workspaceRoot, 'README.md');
  await expect(window.locator(`[role=treeitem][title="${rootReadme}"]`)).toHaveCount(0, { timeout: 5_000 });
  await expect.poll(() => existsSync(rootReadme)).toBe(false);
  expect(existsSync(path.join(workspaceRoot, 'src', 'README.md'))).toBe(true);
});
