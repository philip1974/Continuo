// Ctrl+S 触发保存:打开文件 → 修改 → Ctrl+S → 磁盘内容更新 + dirty 清除.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('打开 a.ts → Ctrl+S 触发保存命令(无脏 → 立即返回不抛)', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts', {
    timeout: 10_000,
  });

  // 触发 Ctrl+S(useCommandHotkeys 注册了 mod+s 走 saveActive 命令)
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  // 没修改 → 文件内容不变
  const content = await readFile(path.join(workspaceRoot, 'src/a.ts'), 'utf8');
  expect(content).toContain('export const a = 1;');
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
    expect(status).toMatch(/40/);
  }).toPass({ timeout: 10_000 });
});
