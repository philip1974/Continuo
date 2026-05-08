// Quick Open walk 只列文件不列目录(walkWorkspaceFiles 跳过 isDirectory).
import { test, expect } from './fixtures/with-workspace';

test('Quick Open 列表含文件 (a.ts/b.ts/README.md) 不含目录 (src)', async ({
  window,
}) => {
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const input = window.locator(
    '.wm-modal-content input[placeholder*="搜索文件名"]',
  );
  await expect(input).toBeVisible();

  // 等 walk 完成
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', {
    timeout: 10_000,
  });

  // 文件可见
  const items = window.locator('.wm-modal-content li');
  const text = (await items.allTextContents()).join('\n');
  expect(text).toContain('README.md');
  expect(text).toContain('a.ts');
  expect(text).toContain('b.ts');
  // 目录 'src' 不被列
  expect(text).not.toMatch(/^src$/m);
  // 但 relPath 'src/a.ts' 含 'src',只要 a.ts/b.ts 在就 ok
});
