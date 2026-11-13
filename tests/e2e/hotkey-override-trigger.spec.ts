// override hotkey 后,新组合真触发命令(useCommandHotkeys 走 effective).
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/electron-app';
import { dispatchModKey } from './helpers/hotkeys';
import { SETTINGS, SETTINGS_NAV } from './helpers/settings';

// 全局热键的监听在 App 挂载后的 effect 里注册,改键后的绑定表也要等 React 下一次提交(render + effect)。
// `__continuoTest` 在 createRoot().render() 之后同步挂上,早于 App 首次提交 —— 只等它就派发按键会赛跑
//(实测约四分之一的概率按键先到)。先等 App 真的挂载(Settings 按钮可见),改键后再让出两帧。
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

test('override settings.toggle 为 mod+shift+y → 按下新组合 → 打开 Settings', async ({
  window,
}) => {
  await appMounted(window);
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setHotkey: (commandId: string, hotkey: string) => void;
        };
      }
    ).__continuoTest;
    t.setHotkey('settings.toggle', 'mod+shift+y');
  });
  await bindingsApplied(window);

  await dispatchModKey(window, 'y', { shift: true });

  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
});

test('override 后 → 旧 hotkey ⌘, 不再触发', async ({ window }) => {
  await appMounted(window);
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // override 走 setHotkey
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setHotkey: (commandId: string, hotkey: string) => void;
        };
      }
    ).__continuoTest;
    t.setHotkey('settings.toggle', 'mod+shift+y');
  });
  await bindingsApplied(window);

  await dispatchModKey(window, ',');

  // 等待几秒后 nav 仍不可见(旧 hotkey 不再绑定)
  await window.waitForTimeout(500);
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toHaveCount(0);
});
