// F2 触发重命名(headless-tree renamingFeature):选中行 + F2 进 RenameInput.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('选中 a.ts + F2 → RenameInput 进 + Enter 提交', async ({
  window,
  workspaceRoot,
}) => {
  // 展开 src + 单击 a.ts(选中 + 打开 editor)
  await window.locator('text=src').first().click();
  const aRow = window.locator('text=a.ts').first();
  await aRow.click();
  await expect(aRow).toBeVisible();

  // F2 — headless-tree hotkeysCoreFeature + renamingFeature 接管
  await aRow.press('F2');

  // 焦点在 RenameInput 上
  const input = window.locator('input:focus');
  await expect(input).toBeVisible({ timeout: 5_000 });

  // 全选 + 改名
  await input.press('ControlOrMeta+KeyA');
  await input.fill('aa.ts');
  await input.press('Enter');

  // 磁盘文件改名
  await expect(async () => {
    const r = await readFile(path.join(workspaceRoot, 'src/aa.ts'), 'utf8');
    expect(r).toContain('export const a');
  }).toPass({ timeout: 5_000 });
});
