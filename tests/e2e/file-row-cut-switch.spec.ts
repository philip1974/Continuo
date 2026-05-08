// cut README.md (ghost) → cut a.ts → README.md 不再 ghost,a.ts ghost.
import { test, expect } from './fixtures/with-workspace';

test('cut README.md → cut a.ts → README.md ghost 清,a.ts ghost', async ({
  window,
}) => {
  const readmeRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: /^README\.md$/ })
    .first();

  // cut README.md
  await readmeRow.click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^剪切$/ }).click();

  await expect(async () => {
    const cls = (await readmeRow.getAttribute('class')) ?? '';
    expect(cls).toContain('opacity-50');
  }).toPass({ timeout: 5_000 });

  // 展开 src + cut a.ts
  await window.locator('text=src').first().click();
  const aRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: /^a\.ts$/ })
    .first();
  await aRow.click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^剪切$/ }).click();

  // 等 store update propagation
  await expect(async () => {
    const aCls = (await aRow.getAttribute('class')) ?? '';
    expect(aCls).toContain('opacity-50');
    // README.md 不再 ghost
    const rCls = (await readmeRow.getAttribute('class')) ?? '';
    expect(rCls).not.toContain('opacity-50');
  }).toPass({ timeout: 5_000 });
});
