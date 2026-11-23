// 同 hotkey 多命令 → useCommandHotkeys 内 for 循环命中第一条即 return。testing hook 注册的 fn 为空,无法观察后注册者
// 是否响应;本用例只验证先注册的 settings.toggle 仍被触发.
import { test, expect } from './fixtures/electron-app';
import { dispatchModKey } from './helpers/hotkeys';
import { SETTINGS, SETTINGS_NAV } from './helpers/settings';
import { COMMAND_LIST, commandPaletteInput, openCommandPalette } from './helpers/palette';

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
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });

  // settings.toggle 已注册 hotkey='mod+,';再注册一条 'e2e.dup' 也用 mod+,
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
  // 新命令要经过一次 React 提交才会进入热键绑定表:让出两帧再按键,否则按键可能打到只有 settings.toggle 的旧表。
  await window.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

  await dispatchModKey(window, ',');

  // settings.toggle 仍触发(第一注册者赢)→ Settings panel 出现
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });

  // e2e.dup 确实已注册(否则「先注册者赢」无从谈起):命令面板中能搜到它
  await openCommandPalette(window);
  await commandPaletteInput(window).fill('E2E Dup');
  await expect(
    window.getByRole('listbox', { name: COMMAND_LIST }).getByRole('option').filter({ hasText: 'E2E Dup' }),
  ).toBeVisible();
});
