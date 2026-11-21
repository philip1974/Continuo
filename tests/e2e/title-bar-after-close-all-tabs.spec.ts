import { EDITOR_CLOSE_README_MD } from './helpers/editor';
// 关全部 tab → header 不显文件名,仅显 workspace name(还有 root).
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('开 README.md → 关 → header 仅 workspace name', async ({
  window,
  workspaceRoot,
}) => {
  const wsName = path.basename(workspaceRoot);

  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // 紧凑模式 close
  await window.getByRole('button', { name: EDITOR_CLOSE_README_MD }).click();
  await window.waitForTimeout(300);

  // 不再显 README.md(忽略 ● 单字符)
  const text = await window.locator('header').first().textContent();
  expect(text).toContain(wsName);
  expect(text).not.toMatch(/README\.md/);
});
