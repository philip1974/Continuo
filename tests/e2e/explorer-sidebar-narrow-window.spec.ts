// 极窄窗口(BDD: src/__tests__/explorer-sidebar/ 窄窗口让位):资源管理器 + 搜索组 + 编辑组在 400×800 时,侧栏缩到最小宽
// dock 仍放不下 → 侧栏收起,所有 dock 组(含最右组的「⋯」按钮)都在窗口内;单组时 400 宽仍保留最小宽侧栏。
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';

const QUERY = /^(搜索|Search|검색)$/;
const sidebar = (window: Page) => window.locator('aside[data-workbench-part="sidebar"]');
const groupsRightEdge = (window: Page) =>
  window.evaluate(() => Math.max(...[...document.querySelectorAll('.dv-groupview')].map((g) => g.getBoundingClientRect().right)));

test('400×800:单组保留最小宽侧栏;再加搜索组放不下 → 侧栏收起,所有组都在窗口内', async ({ window, electronApp }) => {
  await waitForTestHooks(window);
  await window.locator('text=README.md').first().dblclick();
  await expect(window.locator('.dv-groupview')).toHaveCount(1, { timeout: 10_000 });
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(400, 800));
  await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(400);
  await expect(sidebar(window)).toBeVisible();
  await expect.poll(() => groupsRightEdge(window)).toBeLessThanOrEqual(400.5);

  await window.keyboard.press('ControlOrMeta+Shift+KeyF');
  await expect(window.getByRole('textbox', { name: QUERY })).toBeVisible({ timeout: 10_000 });
  await expect(window.locator('.dv-groupview')).toHaveCount(2);
  await expect(sidebar(window)).toBeHidden({ timeout: 5_000 });
  await expect.poll(() => groupsRightEdge(window)).toBeLessThanOrEqual(400.5);
  // 最右组的头部动作按钮在窗口内
  const actions = await window.evaluate(() =>
    [...document.querySelectorAll('.dv-groupview')].map((g) => {
      const btn = g.querySelector('.dv-right-actions-container button');
      return btn ? btn.getBoundingClientRect().right : 0;
    }),
  );
  for (const right of actions) expect(right).toBeLessThanOrEqual(400.5);

  // 用户在窄窗口里再打开侧栏:不被立刻收回
  await window.keyboard.press('ControlOrMeta+KeyB');
  await expect(sidebar(window)).toBeVisible();
  await window.waitForTimeout(300);
  await expect(sidebar(window)).toBeVisible();
});
