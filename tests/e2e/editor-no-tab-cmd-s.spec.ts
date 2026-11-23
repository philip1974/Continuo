import { EDITOR_NO_FILE_OPEN } from './helpers/editor';
// 无 active tab(EditorWelcome 状态)→ Cmd+S 不抛(saveActive 返 NO_ACTIVE_TAB 时 handleSave 走
// notifyFailure toast,不调 alert).
import { test, expect } from './fixtures/with-workspace';

test('无 tab + Cmd+S → 不抛(EditorPanel 容器 onKeyDown)', async ({
  window,
}) => {
  // 拦截 alert
  await window.evaluate(() => {
    (window as unknown as { alert: () => void }).alert = () => {};
  });

  // EditorWelcome 状态
  await expect(window.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible({
    timeout: 10_000,
  });

  // 在 main 区域 dispatch keydown(Cmd+S 由 EditorPanel onKeyDown 接)
  await window.locator('main').first().focus().catch(() => {});
  await window.keyboard.press('ControlOrMeta+KeyS');

  // app 不崩 + EditorWelcome 仍在
  await expect(window.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible();
});
