// unbind hotkey(空字符串覆盖)→ 该 hotkey 不再触发命令.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/electron-app';
import { dispatchModKey } from './helpers/hotkeys';
import { CLOSE_SETTINGS, SETTINGS, SETTINGS_NAV } from './helpers/settings';
import { waitForTestHooks } from './helpers/app-ready';

// 全局热键监听在 App 挂载后的 effect 里注册,改键后的绑定表也要等下一次提交 —— 与 hotkey-override-trigger 同法:
// 先等 App 挂载(Settings 按钮可见),改键后再让出两帧。否则按键可能先于监听注册到达,负断言恒真。
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

test('unbind settings.toggle(空字符串)→ ⌘, 不再触发', async ({
  window,
}) => {
  await appMounted(window);
  await waitForTestHooks(window);

  // 正向对照:解绑前 ⌘, 能打开 Settings(证明热键通路已就绪),再关掉
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(async () => {
    await dispatchModKey(window, ',');
    await expect(nav).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await window.getByRole('button', { name: CLOSE_SETTINGS }).click();
  await expect(nav).toHaveCount(0, { timeout: 5_000 });

  // unbind
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.setHotkey('settings.toggle', '');
  });
  await bindingsApplied(window);

  await dispatchModKey(window, ',');
  await window.waitForTimeout(500);

  // Settings panel 不应打开
  await expect(nav).toHaveCount(0);

  // 但齿轮按钮点击仍能开
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(nav).toBeVisible({
    timeout: 10_000,
  });
});
