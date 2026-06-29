// Quick Open 输入路径片段 (e.g. 'src/a') → 匹配 src/a.ts.
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test('搜 src/a → 列出 src/a.ts', async ({ window }) => {
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();
  // 等 walk
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', {
    timeout: 10_000,
  });

  await input.fill('src/a');
  // 仅 src/a.ts 匹配,b.ts 与 README.md 应过滤掉
  const items = window.locator('.wm-modal-content li');
  await expect(items.first()).toContainText('a.ts');
  await expect(items.first()).toContainText('src/a.ts');
  // README.md 不匹配
  const text = (await items.allTextContents()).join('\n');
  expect(text).not.toContain('README.md');
});
