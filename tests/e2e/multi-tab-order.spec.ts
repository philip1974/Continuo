// 多文件依次打开 → TabNav 顺序保持(open 顺序).
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS, openWorkspaceFile } from './helpers/editor';

test('依次开 README.md → a.ts → b.ts → tab 顺序固定', async ({ window }) => {
  await openWorkspaceFile(window, ['README.md']);
  await openWorkspaceFile(window, ['src', 'a.ts']);
  await openWorkspaceFile(window, ['src', 'b.ts']);

  const tabs = window.getByRole('tablist', { name: EDITOR_TABS }).locator('[role=tab]');
  await expect(tabs).toHaveCount(3);

  // 顺序:README.md → a.ts → b.ts
  await expect(tabs.nth(0)).toContainText('README.md');
  await expect(tabs.nth(1)).toContainText('a.ts');
  await expect(tabs.nth(2)).toContainText('b.ts');
});
