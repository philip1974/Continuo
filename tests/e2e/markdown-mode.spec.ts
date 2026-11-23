// 打开 .md 文件 → EditorPanel 的模式行显示 SegmentedControl(Edit/Source/Preview);按 isMarkdownPath 显示,
// 与 autoSave 无关(代码文件没有模式行).
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_MODE_EDIT,
  EDITOR_MODE_PREVIEW,
  EDITOR_MODE_SOURCE,
  EDITOR_SAVE_LABEL,
} from './helpers/editor';

test('打开 README.md → 模式行 SegmentedControl 出现 + 不显「保存」按钮', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  // 等 EditorHeader 渲染完成(显示 README.md basename)
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  // 模式行(EditorPanel 内、tab 行下方)SegmentedControl 含 Edit / Source / Preview 文本
  const main = window.locator('main');
  await expect(main.locator('button').filter({ hasText: EDITOR_MODE_EDIT })).toBeVisible();
  await expect(
    main.locator('button').filter({ hasText: EDITOR_MODE_SOURCE }),
  ).toBeVisible();
  await expect(
    main.locator('button').filter({ hasText: EDITOR_MODE_PREVIEW }),
  ).toBeVisible();

  // 「保存」按钮不存在(autoSaveEnabled=true 路径)
  await expect(
    window.getByRole('button', { name: EDITOR_SAVE_LABEL }),
  ).toHaveCount(0);
});

test('打开 .ts 代码文件 → 不显保存按钮(无 SegmentedControl)', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts', {
    timeout: 10_000,
  });

  // EditorHeader 不再显示保存按钮,保存走 Cmd/Ctrl+S.
  const main = window.locator('main');
  await expect(
    window.getByRole('button', { name: EDITOR_SAVE_LABEL }),
  ).toHaveCount(0);
  await expect(
    main.locator('button').filter({ hasText: EDITOR_MODE_EDIT }),
  ).toHaveCount(0);
});
