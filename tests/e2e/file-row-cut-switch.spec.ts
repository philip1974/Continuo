// cut README.md (ghost) → cut a.ts → README.md 不再 ghost,a.ts ghost.
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_CUT, expandTreeItem, explorerTreeItem } from './helpers/explorer';

test('cut README.md → cut a.ts → README.md ghost 清,a.ts ghost', async ({ window }) => {
  const readmeRow = explorerTreeItem(window, /^README\.md$/);

  // cut README.md
  await readmeRow.click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_CUT }).click();

  await expect(async () => {
    const cls = (await readmeRow.getAttribute('class')) ?? '';
    expect(cls).toContain('opacity-50');
  }).toPass({ timeout: 5_000 });

  // 展开 src + cut a.ts
  await expandTreeItem(window, /^src$/);
  const aRow = explorerTreeItem(window, /^a\.ts$/);
  await aRow.click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_CUT }).click();

  // 等 store update propagation
  await expect(async () => {
    const aCls = (await aRow.getAttribute('class')) ?? '';
    expect(aCls).toContain('opacity-50');
    // README.md 不再 ghost
    const rCls = (await readmeRow.getAttribute('class')) ?? '';
    expect(rCls).not.toContain('opacity-50');
  }).toPass({ timeout: 5_000 });
});
