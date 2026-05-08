// copy + 二次 paste → 第二份用 ' copy' 后缀;clipboard 不清.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('copy README.md → paste 到 src(N=1)→ 再 paste(N=2) → src 内 2 份', async ({
  window,
  workspaceRoot,
}) => {
  // copy README.md
  await window.locator('text=README.md').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^复制$/ }).click();

  // 展开 src
  await window.locator('text=src').first().click();

  // 第一次 paste → src/README.md
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^粘贴$/ }).click();
  await expect(async () => {
    await stat(path.join(workspaceRoot, 'src/README.md'));
  }).toPass({ timeout: 5_000 });

  // 第二次 paste → 自动 ' copy' 后缀 (clipboard 仍含)
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^粘贴$/ }).click();

  await expect(async () => {
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(path.join(workspaceRoot, 'src'));
    const readmeCount = files.filter((f) =>
      f.toLowerCase().includes('readme'),
    ).length;
    expect(readmeCount).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 5_000 });
});
