// dock 组不超出窗口、每组活动 tab 可见(BDD:src/__tests__/dock-terminal-vscode-focus 第 4、6 条)。
// 连开 10 个终端:放不下的终端作为 tab 加入最后一个终端组,所有组都在 dock 内;缩窄窗口后各组活动 tab 仍在 tab 条可见区。
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { TERMINAL_PANEL_TAB } from './helpers/editor';

/** 每个 grid 组相对 dock 的左右边界,与 dock 本身的边界。 */
function groupBounds(window: Page) {
  return window.evaluate(() => {
    const dock = document.querySelector<HTMLElement>('.dv-dockview')!.getBoundingClientRect();
    const groups = [...document.querySelectorAll<HTMLElement>('.dv-dockview .dv-groupview')].map((g) => {
      const r = g.getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    return { dock: { left: dock.left, right: Math.min(dock.right, globalThis.innerWidth) }, groups };
  });
}

/** 每个组的活动 tab 是否完整落在其 tab 条可见区内。 */
function activeTabsVisible(window: Page) {
  return window.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.dv-dockview .dv-tabs-container')].every((list) => {
      const tab = list.querySelector<HTMLElement>(':scope > .dv-tab.dv-active-tab');
      if (!tab) return true;
      const l = list.getBoundingClientRect();
      const t = tab.getBoundingClientRect();
      return t.left >= l.left - 1 && t.right <= l.right + 1;
    }),
  );
}

test('连开 10 个终端:所有组都在 dock 内,10 个终端都在;缩窄窗口后各组活动 tab 仍可见', async ({
  window,
  electronApp,
}) => {
  await waitForTestHooks(window);
  for (let i = 0; i < 10; i++) {
    expect(await window.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
    await expect(window.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(i + 1, { timeout: 15_000 });
  }

  const { dock, groups } = await groupBounds(window);
  expect(groups.length).toBeGreaterThan(1);
  for (const g of groups) {
    expect(g.left).toBeGreaterThanOrEqual(dock.left - 1);
    expect(g.right).toBeLessThanOrEqual(dock.right + 1);
  }
  await expect.poll(() => activeTabsVisible(window)).toBe(true);

  await electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    const [, h] = w.getSize();
    w.setSize(800, h!);
  });
  await expect.poll(() => activeTabsVisible(window), { timeout: 5_000 }).toBe(true);
});
