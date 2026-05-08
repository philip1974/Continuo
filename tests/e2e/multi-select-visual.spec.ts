// Cmd+click 多选 → 两 row 都 bg-hover.
import { test, expect } from './fixtures/with-workspace';

test('点 README + Cmd+click src → 两 row 都 bg-hover', async ({ window }) => {
  const readmeRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: 'README.md' })
    .first();
  const srcRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: 'src' })
    .first();

  await readmeRow.click();
  await srcRow.click({ modifiers: ['ControlOrMeta'] });

  await expect(async () => {
    const r1 = (await readmeRow.getAttribute('class')) ?? '';
    const r2 = (await srcRow.getAttribute('class')) ?? '';
    expect(r1).toContain('bg-hover');
    expect(r2).toContain('bg-hover');
  }).toPass({ timeout: 3_000 });
});
