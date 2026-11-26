// Dockview popout button → 弹出第二个 Electron window,渲染 PopoutHost.
//
// 此前一直被 skip,注释写的是「addPopoutGroup 在 Playwright 下不稳定,子窗未创建」。真正的原因是
// windowOpenHandler 在「未打包且没有 dev server」(e2e / 预览正是这种)时把所有 popout 都拒了
//(见 electron/main/window-open-policy.ts)。修掉之后子窗能正常弹出,本用例恢复启用。

import { test, expect } from './fixtures/electron-app';
import { DOCK_POPOUT } from './helpers/editor';

test('Popout 按钮 → 第二个 window 弹出 + 渲染 PopoutHost', async ({
  electronApp,
  window,
}) => {
  // 第一个 window 已存在(主)。点 popout 按钮 — 默认 layout 有 1 个 Editor panel,
  // 它是 active,popout 应可用。
  const popoutBtn = window.getByRole('button', { name: DOCK_POPOUT });
  await expect(popoutBtn).toBeEnabled({ timeout: 10_000 });

  await popoutBtn.click();

  // 等到 windows 数量 >= 2(轮询,避免 waitForEvent timeout 路径)
  await expect.poll(async () => electronApp.windows().length).toBeGreaterThan(
    1,
  );
  const secondWindow = electronApp
    .windows()
    .find((w) => w !== window);
  expect(secondWindow).toBeDefined();
  if (!secondWindow) throw new Error('no second window');
  await secondWindow.waitForLoadState('domcontentloaded');

  // popout window 渲染 PopoutHost(data-testid='popout-host')
  await expect(secondWindow.locator('[data-testid=popout-host]')).toBeVisible(
    { timeout: 10_000 },
  );

  // 子窗也暴露 __lmApi(同源 + 注入 preload)
  const hasLmApi = await secondWindow.evaluate(() =>
    Boolean((window as unknown as { __lmApi?: unknown }).__lmApi),
  );
  expect(hasLmApi).toBe(true);

  // 子窗关闭 + 主窗仍正常
  await secondWindow.close();
  await expect(window.locator('header').first()).toBeVisible();
});

// VSCode:辅助窗口关闭、编辑器收回主窗后获焦。从多面板组(编辑器 + 设置)里弹出活动的编辑器时 dockview 不派发活动组 /
// 活动面板事件,此前关子窗后收回的编辑器不获焦,主窗焦点留在 body(点弹出按钮时它随 header 挪进子窗,主窗焦点即丢失)。
test('从多面板组弹出编辑器 → 关子窗 → 主窗焦点回到收回的编辑器', async ({ electronApp, window }) => {
  await expect(window.getByRole('button', { name: DOCK_POPOUT }).first()).toBeEnabled({ timeout: 10_000 });
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.openOrFocusPanel('settings', 'settings', 'Settings');
    t.focusPanel('editor');
  });
  // 编辑器与设置同组,编辑器为活动面板
  const sameGroup = await window.evaluate(() => {
    const tab = (name: RegExp) => [...document.querySelectorAll('.dv-tab')].find((el) => name.test(el.textContent ?? ''));
    const e = tab(/^(编辑器|Editor|편집기)/);
    const s = tab(/^(设置|Settings|설정)/);
    return Boolean(e && s && e.closest('.dv-groupview') === s.closest('.dv-groupview'));
  });
  expect(sameGroup).toBe(true);
  const popoutBtn = window
    .locator('[data-editor-panel-root]')
    .first()
    .locator('xpath=ancestor::*[contains(@class,"dv-groupview")]')
    .getByRole('button', { name: DOCK_POPOUT });
  await popoutBtn.click();
  await expect.poll(() => electronApp.windows().length).toBeGreaterThan(1);
  const child = electronApp.windows().find((w) => w !== window)!;
  await expect(child.locator('[data-testid=popout-host]')).toBeVisible({ timeout: 10_000 });

  await electronApp.evaluate(({ BrowserWindow }) => {
    const [main, ...rest] = BrowserWindow.getAllWindows().sort((a, b) => a.id - b.id);
    for (const w of rest) w.close();
    main?.focus();
  });
  await expect.poll(() => electronApp.windows().length).toBe(1);
  await expect
    .poll(() =>
      window.evaluate(() => {
        const a = document.activeElement;
        return a !== null && a !== document.body && a.closest('[data-editor-panel-root]') !== null;
      }),
    )
    .toBe(true);
});
