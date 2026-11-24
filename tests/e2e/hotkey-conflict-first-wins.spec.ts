// 同 hotkey 多命令 → useCommandHotkeys 分发表命中第一条即 return。表序:用户 override 的命令在前(对齐 VSCode:用户绑定
// 优先于默认),同层按注册顺序。testing hook 注册的 fn 为空,无法直接观察它是否响应;用例经 settings.toggle 是否打开设置
// 面板间接观察:两条都是默认绑定 → 先注册的 settings.toggle 响应;用户把后注册那条设成同键 → 它胜出,设置面板不再打开。
import { test, expect } from './fixtures/electron-app';
import { dispatchModKey } from './helpers/hotkeys';
import { SETTINGS, SETTINGS_NAV } from './helpers/settings';
import { COMMAND_LIST, commandPaletteInput, openCommandPalette } from './helpers/palette';
import { waitForTestHooks } from './helpers/app-ready';

test('注册同 hotkey 第二条命令 → 第一条仍优先(getAll insertion 顺序)', async ({
  window,
}) => {
  await waitForTestHooks(window);
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });

  // settings.toggle 已注册 hotkey='mod+,';再注册一条 'e2e.dup' 也用 mod+,
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
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

test('用户把后注册命令设成 mod+, → 用户绑定优先,默认的 settings.toggle 让出', async ({ window }) => {
  await waitForTestHooks(window);
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({ timeout: 10_000 });

  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.registerCommand('e2e.user-wins', 'E2E User Wins');
    t.setHotkey('e2e.user-wins', 'mod+,');
  });
  await window.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

  await dispatchModKey(window, ',');
  // 负断言:给分发与渲染留足时间后,设置面板仍未出现(由 e2e.user-wins 空命令接走)。
  await window.waitForTimeout(500);
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toHaveCount(0);
});
