// .md 文件打开后,EditorHeader SegmentedControl 切换 Edit/Source/Preview.
// 切换写 editor.store.mode,影响 EditorPanel body 渲染.
import { test, expect } from './fixtures/with-workspace';

test('Edit (默认) → Source → Preview 切换', async ({ window }) => {
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // SegmentedControl 用 button 实现,文本 'Edit' / 'Source' / 'Preview'
  const main = window.locator('main');
  const editBtn = main
    .locator('button')
    .filter({ hasText: /^Edit$/ })
    .first();
  const sourceBtn = main
    .locator('button')
    .filter({ hasText: /^Source$/ })
    .first();
  const previewBtn = main
    .locator('button')
    .filter({ hasText: /^Preview$/ })
    .first();

  await expect(editBtn).toBeVisible();
  await expect(sourceBtn).toBeVisible();
  await expect(previewBtn).toBeVisible();

  // 默认 mode='edit',Edit 按钮 active(SegmentedControl data-active='true')
  await expect(editBtn).toHaveAttribute('data-active', 'true');

  // 切到 Source
  await sourceBtn.click();
  await expect(sourceBtn).toHaveAttribute('data-active', 'true');
  await expect(editBtn).toHaveAttribute('data-active', 'false');

  // 切到 Preview
  await previewBtn.click();
  await expect(previewBtn).toHaveAttribute('data-active', 'true');
});
