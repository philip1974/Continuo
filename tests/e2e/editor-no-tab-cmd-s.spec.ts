// 无 active tab(EditorWelcome 状态)→ Cmd+S 不抛(handleSave 检 saveActive 返
// NO_ACTIVE_TAB,alert 弹但 e2e 拦截).
import { test, expect } from './fixtures/with-workspace';

test('无 tab + Cmd+S → 不抛(EditorPanel 容器 onKeyDown)', async ({
  window,
}) => {
  // 拦截 alert
  await window.evaluate(() => {
    (window as unknown as { alert: () => void }).alert = () => {};
  });

  // EditorWelcome 状态
  await expect(window.getByText('未打开文件').first()).toBeVisible({
    timeout: 10_000,
  });

  // 在 main 区域 dispatch keydown(Cmd+S 由 EditorPanel onKeyDown 接)
  await window.locator('main').first().focus().catch(() => {});
  await window.keyboard.press('ControlOrMeta+KeyS');

  // app 不崩 + EditorWelcome 仍在
  await expect(window.getByText('未打开文件').first()).toBeVisible();
});
