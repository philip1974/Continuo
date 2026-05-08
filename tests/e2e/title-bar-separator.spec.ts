// TitleBar 同时有 active file 与 workspace → 文本含「  ·  」分隔符.
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('打开 README.md → TitleBar 文本含「README.md  ·  ${ws}」', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=README.md').first().click();
  const wsName = path.basename(workspaceRoot);

  // 等 active 设
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });
  await expect(window.locator('header').first()).toContainText(wsName);

  // 文本字符串模式:  README.md  ·  basename
  const text = await window.locator('header').first().textContent();
  expect(text).toMatch(/README\.md.*·.*/);
  expect(text).toContain(wsName);
});
