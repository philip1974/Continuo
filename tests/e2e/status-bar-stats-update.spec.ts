// StatusBar 行/词/字符计数随 active tab 切换更新.
import { test, expect } from './fixtures/with-workspace';

test('切 README.md → a.ts → 字符数变化', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // README.md = '# Test Workspace\n' = 17 chars
  const readmeStatus = await window.locator('footer').textContent();
  expect(readmeStatus).toMatch(/17\s*字符/);

  // 切 a.ts(展开 src)
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts');

  // src/a.ts = 'export const a = 1;\n' = 20 chars
  const aStatus = await window.locator('footer').textContent();
  expect(aStatus).toMatch(/20\s*字符/);
});
