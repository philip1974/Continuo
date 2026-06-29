// EditorWelcome 默认 hint 含「在 Explorer 单击文件打开」+ ⌘ + S + 「保存」文案.
import { test, expect } from './fixtures/electron-app';
import {
  EDITOR_NO_FILE_OPEN,
  EDITOR_SAVE_LABEL,
  EDITOR_SAVE_TEXT,
  EDITOR_WELCOME_HINT,
} from './helpers/editor';

test('启动后 → EditorWelcome 显完整 hint', async ({ window }) => {
  await expect(window.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible({
    timeout: 5_000,
  });
  await expect(window.getByText(EDITOR_WELCOME_HINT)).toBeVisible();
  // KeyCap ⌘ S
  const main = window.locator('main');
  await expect(main).toContainText('⌘');
  await expect(main).toContainText('S');
  await expect(window.getByText(EDITOR_SAVE_LABEL)).toBeVisible();
  await expect(main).toContainText(EDITOR_SAVE_TEXT);
});
