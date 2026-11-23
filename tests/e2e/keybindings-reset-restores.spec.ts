// override hotkey → 原快捷键失效、新快捷键生效;再 override 回原值 → 原快捷键恢复生效
//(testing hook 不暴露 store.reset,以「设回原值」代替)。
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/electron-app';
import { dispatchModKey } from './helpers/hotkeys';
import { CLOSE_SETTINGS, SETTINGS, SETTINGS_NAV } from './helpers/settings';

// 全局热键监听在 App 挂载后的 effect 里注册,改键后的绑定表也要等下一次提交 —— 同 hotkey-unbind:
// 先等 App 挂载,改键后让出两帧,再按键。
async function appMounted(window: Page): Promise<void> {
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({ timeout: 10_000 });
}

async function bindingsApplied(window: Page): Promise<void> {
  await window.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function setHotkey(window: Page, hotkey: string): Promise<void> {
  await window.evaluate((h) => {
    (
      window as unknown as {
        __continuoTest: { setHotkey: (commandId: string, hotkey: string) => void };
      }
    ).__continuoTest.setHotkey('settings.toggle', h);
  }, hotkey);
  await bindingsApplied(window);
}

test('override → 原 ⌘, 失效、新键生效;设回 mod+, → ⌘, 恢复打开 Settings', async ({ window }) => {
  await appMounted(window);
  await window.waitForFunction(
    () => Boolean((window as unknown as { __continuoTest?: unknown }).__continuoTest),
    { timeout: 5_000 },
  );
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });

  // 改键为 mod+shift+y:⌘, 不再打开 Settings
  await setHotkey(window, 'mod+shift+y');
  await dispatchModKey(window, ',');
  await window.waitForTimeout(500);
  await expect(nav).toHaveCount(0);

  // 新键生效:mod+shift+y 打开 Settings,再关掉
  await dispatchModKey(window, 'y', { shift: true });
  await expect(nav).toBeVisible({ timeout: 10_000 });
  await window.getByRole('button', { name: CLOSE_SETTINGS }).click();
  await expect(nav).toHaveCount(0);

  // 设回 mod+,:⌘, 恢复打开 Settings
  await setHotkey(window, 'mod+,');
  await dispatchModKey(window, ',');
  await expect(nav).toBeVisible({ timeout: 10_000 });
});
