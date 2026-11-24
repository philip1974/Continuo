// 有终端在 popout 子窗时新建终端不出错;关闭子窗后收回的终端获焦(BDD:dock-terminal-vscode-focus 第 1、3 条)。
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { DOCK_POPOUT, TERMINAL_INPUT, TERMINAL_PANEL_TAB } from './helpers/editor';

test('终端弹出到子窗后再新建终端 → 不报错;关闭子窗 → 收回的终端成为活动面板', async ({ electronApp, window }) => {
  const pageErrors: string[] = [];
  window.on('pageerror', (e) => pageErrors.push(e.message));
  await waitForTestHooks(window);
  const newTerminal = () => window.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'));

  expect(await newTerminal()).toBe(true);
  const firstTab = window.getByRole('tab', { name: TERMINAL_PANEL_TAB });
  await expect(firstTab).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  const firstName = (await firstTab.textContent())?.trim() ?? '';

  // 弹出终端所在组的活动面板(终端)
  const group = window.locator('.dv-groupview', { has: firstTab });
  await group.getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => electronApp.windows().length).toBeGreaterThan(1);
  const child = electronApp.windows().find((w) => w !== window)!;
  await child.waitForLoadState('domcontentloaded');
  await expect(child.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(1, { timeout: 10_000 });

  // 再新建终端:此前 Reconciler 以 popout 中的终端作参照 → dockview 抛错、无面板。现在落在主窗 grid。
  await window.bringToFront();
  expect(await newTerminal()).toBe(true);
  await expect(window.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(1, { timeout: 15_000 });
  await expect(window.getByRole('alert')).toHaveCount(0);
  expect(pageErrors.filter((m) => /parentElement|referencePanel/.test(m))).toEqual([]);

  // 关闭子窗:终端收回主窗,成为活动面板并获焦
  await child.close({ runBeforeUnload: true });
  await expect.poll(() => electronApp.windows().length).toBe(1);
  const returned = window.getByRole('tab', { name: firstName });
  await expect(returned).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
  await expect(window.getByRole('textbox', { name: TERMINAL_INPUT }).first()).toBeAttached();
});
