// 多选 + 移到废纸篓:批量删除多个文件.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_TRASH } from './helpers/explorer';

test('Cmd-click 多选 a.ts + b.ts → 移到废纸篓 → 都消失', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await window
    .locator('text=b.ts')
    .first()
    .click({ modifiers: ['ControlOrMeta'] });

  // 右键 a.ts(在选中集合内)
  await window.locator('text=a.ts').first().click({
    button: 'right',
    modifiers: ['ControlOrMeta'],
  });
  await window.getByRole('menuitem', { name: EXPLORER_TRASH }).click();

  // 两个文件都消失
  await expect(async () => {
    const aExists = await stat(path.join(workspaceRoot, 'src/a.ts'))
      .then(() => true)
      .catch(() => false);
    const bExists = await stat(path.join(workspaceRoot, 'src/b.ts'))
      .then(() => true)
      .catch(() => false);
    expect(aExists).toBe(false);
    expect(bExists).toBe(false);
  }).toPass({ timeout: 5_000 });
});
