// 剪切 src/a.ts → 粘贴到 root → 文件被 move(原位置消失,目标位置出现).
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('右键 README.md 剪切 → 右键 src 粘贴 → src/README.md 出现 + 原 README.md 消失', async ({
  window,
  workspaceRoot,
}) => {
  // 剪切 README.md
  await window.locator('text=README.md').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^剪切$/ }).click();

  // 展开 src + 右键 src → 粘贴(parent=src)
  await window.locator('text=src').first().click();
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^粘贴$/ }).click();

  // src/README.md 出现
  await expect(async () => {
    await stat(path.join(workspaceRoot, 'src/README.md'));
  }).toPass({ timeout: 5_000 });

  // 原 README.md 消失(cut = move)
  await expect(async () => {
    const exists = await stat(path.join(workspaceRoot, 'README.md'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  }).toPass({ timeout: 5_000 });
});
