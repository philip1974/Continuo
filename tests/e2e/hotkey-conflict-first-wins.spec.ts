// 同 hotkey 多命令 → useCommandHotkeys 内 for 循环命中第一条 return,后注册的不响应.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS_NAV } from './helpers/settings';

test('注册同 hotkey 第二条命令 → 第一条仍优先(getAll insertion 顺序)', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // settings.open 已注册 hotkey='mod+,';再注册一条 'e2e.dup' 也用 mod+,
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          registerCommand: (
            id: string,
            title: string,
            hotkey?: string,
          ) => () => void;
        };
      }
    ).__continuoTest;
    t.registerCommand('e2e.dup', 'E2E Dup', 'mod+,');
  });

  // 按 Ctrl+,
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ',',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  // settings.open 仍触发(第一注册者赢)→ Settings panel 出现
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
});
