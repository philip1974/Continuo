// Ctrl+S 显式保存:在编辑器内修改 → Ctrl+S(EditorPanel 容器 onKeyDown,meta / ctrl 均可)→ 磁盘写入;
// 外部修改 → useExternalFileSync 自动同步 editor 内容.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('打开 a.ts → 编辑器内修改 → Ctrl+S → 磁盘写入', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts', {
    timeout: 10_000,
  });

  const editor = window.locator('.cm-content').first();
  await editor.click();
  await window.keyboard.press('ControlOrMeta+End');
  await window.keyboard.type('\n// saved-by-ctrl-s');
  await window.keyboard.press('Control+s');

  const aPath = path.join(workspaceRoot, 'src/a.ts');
  await expect
    .poll(() => readFile(aPath, 'utf8'), { timeout: 5_000 })
    .toContain('// saved-by-ctrl-s');
});

test('外部修改 a.ts → useExternalFileSync 自动同步 editor 内容', async ({
  window,
  workspaceRoot,
}) => {
  // 打开 src 展开 + a.ts
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts', {
    timeout: 10_000,
  });

  const aPath = path.join(workspaceRoot, 'src/a.ts');
  const newContent = 'export const a = 999; // updated by e2e\n';
  await writeFile(aPath, newContent);

  // fs.watch 推送 → useExternalFileSync 重读 → editor 内容刷新
  // 我们没 codemirror DOM 探针,改用 store 间接:
  // StatusBar 的字符数会随内容变化,等到字符数变化即视为同步成功
  // 初始 a.ts = 'export const a = 1;\n' = 20 chars
  await expect(async () => {
    const status = await window.locator('footer').textContent();
    // 新内容 = 'export const a = 999; // updated by e2e\n' = 40 chars
    expect(status).toMatch(/\b40\s*(chars|字符|자)/);
  }).toPass({ timeout: 10_000 });
});
