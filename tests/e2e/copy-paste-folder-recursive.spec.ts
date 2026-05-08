// 文件夹 copy + paste 到同目录 → 'src copy/' 出现含子文件.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('copy src + paste 同目录 → src copy 出现 + 含 a.ts/b.ts', async ({
  window,
  workspaceRoot,
}) => {
  await expect(window.locator('text=src').first()).toBeVisible({
    timeout: 10_000,
  });

  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^复制$/ }).click();

  // paste 到根:右键 FolderTree 滚动区底部空白(target=null,createParent=root)
  const aside = window.locator('main aside').nth(1);
  const scroll = aside.locator('.overflow-auto.bg-canvas').first();
  const box = await scroll.boundingBox();
  if (!box) throw new Error('scroll box null');
  await scroll.click({
    button: 'right',
    position: {
      x: box.width / 2,
      y: Math.max(box.height - 30, box.height * 0.85),
    },
  });
  await window.getByRole('menuitem', { name: /^粘贴$/ }).click();

  await expect(async () => {
    const dirOk = await stat(path.join(workspaceRoot, 'src copy'))
      .then((s) => s.isDirectory())
      .catch(() => false);
    expect(dirOk).toBe(true);
    // 子文件递归复制
    const aOk = await stat(path.join(workspaceRoot, 'src copy/a.ts'))
      .then(() => true)
      .catch(() => false);
    expect(aOk).toBe(true);
    const bOk = await stat(path.join(workspaceRoot, 'src copy/b.ts'))
      .then(() => true)
      .catch(() => false);
    expect(bOk).toBe(true);
  }).toPass({ timeout: 5_000 });
});
