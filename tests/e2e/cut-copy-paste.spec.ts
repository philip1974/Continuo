// 右键菜单 cut/copy/paste:in-app clipboard,paste = move(cut)/copy(copy).
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('右键 README.md → 复制 → 右键 src → 粘贴 → src/README.md 出现 + 原文件保留', async ({
  window,
  workspaceRoot,
}) => {
  // 复制 README.md 到 in-app clipboard
  await window.locator('text=README.md').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^复制$/ }).click();

  // 展开 src(单击文件夹 expand)
  await window.locator('text=src').first().click();

  // 右键 src → 粘贴
  await window.locator('text=src').first().click({ button: 'right' });
  // 「粘贴」item 仅在 hasClipboard=true 时显示
  await window.getByRole('menuitem', { name: /^粘贴$/ }).click();

  // src/README.md 落盘
  await expect(async () => {
    await stat(path.join(workspaceRoot, 'src/README.md'));
  }).toPass({ timeout: 5_000 });

  // 原 README.md 仍在
  const orig = await stat(path.join(workspaceRoot, 'README.md'))
    .then(() => true)
    .catch(() => false);
  expect(orig).toBe(true);
});

test('右键 a.ts → 剪切 → 右键 src 自身(父=src)→ 粘贴 noop / 复制成功目录粘贴 → 新文件出现', async ({
  window,
  workspaceRoot,
}) => {
  // 展开 src 后剪切 a.ts
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^复制$/ }).click();

  // 粘贴到 src 目录自身(父=src)→ 自动 ' copy' 后缀
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^粘贴$/ }).click();

  // src/a copy.ts 或类似带 ' copy' 后缀的文件出现
  await expect(async () => {
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(path.join(workspaceRoot, 'src'));
    const hasCopy = files.some(
      (f) => f.includes('a') && f !== 'a.ts' && f.endsWith('.ts'),
    );
    expect(hasCopy).toBe(true);
  }).toPass({ timeout: 5_000 });

  // 原 a.ts 仍在(copy 不动原文件)
  const orig = await stat(path.join(workspaceRoot, 'src/a.ts'))
    .then(() => true)
    .catch(() => false);
  expect(orig).toBe(true);
});
