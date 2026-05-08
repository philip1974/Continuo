// 打开 .md 文件 → EditorHeader 显示 mode SegmentedControl(Edit/Source/Preview).
// 这是 autoSaveEnabled 的视觉指示(代码文件没有这个,因为 isAutoSaveEnabled='*.md').
import { test, expect } from './fixtures/with-workspace';

test('打开 README.md → EditorHeader SegmentedControl 出现 + 不显「保存」按钮', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  // 等 EditorHeader 渲染完成(显示 README.md basename)
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // EditorHeader 内 SegmentedControl 含 Edit / Source / Preview 文本
  // 紧凑模式下 SegmentedControl 在右侧控制条
  const main = window.locator('main');
  await expect(main).toContainText('Edit');
  await expect(main).toContainText('Source');
  await expect(main).toContainText('Preview');

  // 「保存」按钮不存在(autoSaveEnabled=true 路径)
  const saveBtns = main
    .locator('button')
    .filter({ hasText: /^保存$/ });
  expect(await saveBtns.count()).toBe(0);
});

test('打开 .ts 代码文件 → 显「保存」按钮(无 SegmentedControl)', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts', {
    timeout: 10_000,
  });

  // EditorHeader 紧凑模式 + 代码文件:isAutoSaveEnabled=false → 显「保存」按钮
  // 没改 → disabled
  const main = window.locator('main');
  const saveBtn = main
    .locator('button')
    .filter({ hasText: /^保存$/ })
    .first();
  await expect(saveBtn).toBeVisible();
  await expect(saveBtn).toBeDisabled();
});
