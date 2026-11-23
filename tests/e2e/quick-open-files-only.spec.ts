// Quick Open walk 只列文件不列目录(walkWorkspaceFiles 跳过 isDirectory).
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test('Quick Open 列表含文件 (a.ts/b.ts/README.md) 不含目录 (src)', async ({
  window,
}) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();

  // 等 walk 完成
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', {
    timeout: 10_000,
  });

  // 每行的名字(span.font-medium;行文本是「名字 + 相对路径」拼接,不能对整行做匹配)
  const names = await window.locator('.wm-modal-content li span.font-medium').allTextContents();
  expect(names).toContain('README.md');
  expect(names).toContain('a.ts');
  expect(names).toContain('b.ts');
  // 目录 'src' 不被列
  expect(names).not.toContain('src');
});
