// 矮窗口里的右键菜单(BDD: src/__tests__/menu-overflow-scroll/):640×300 时编辑器 tab 右键菜单不越出窗口,菜单内可滚轮滚动,
// 键盘 End 把末项滚到可见。
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS } from './helpers/editor';

const menuMetrics = (window: Page) =>
  window.getByRole('menu').evaluate((el) => ({
    bottom: el.getBoundingClientRect().bottom,
    top: el.getBoundingClientRect().top,
    viewport: globalThis.innerHeight,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollTop: el.scrollTop,
    overflowY: getComputedStyle(el).overflowY,
  }));

test('640×300:tab 右键菜单限高在窗口内、可滚轮滚动、End 末项可见', async ({ window, electronApp }) => {
  await window.locator('text=README.md').first().dblclick();
  const tab = window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab').first();
  await expect(tab).toBeVisible({ timeout: 10_000 });
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(640, 300));
  await expect.poll(() => window.evaluate(() => globalThis.innerHeight)).toBeLessThan(320);

  await tab.click({ button: 'right' });
  const menu = window.getByRole('menu');
  await expect(menu).toBeVisible();
  const m = await menuMetrics(window);
  expect(m.top).toBeGreaterThanOrEqual(0);
  expect(m.bottom).toBeLessThanOrEqual(m.viewport + 0.5);
  expect(m.overflowY).toBe('auto');
  expect(m.scrollHeight).toBeGreaterThan(m.clientHeight); // 项多于可视高度 → 需滚动

  const box = (await menu.boundingBox())!;
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.wheel(0, 200);
  await expect.poll(async () => (await menuMetrics(window)).scrollTop).toBeGreaterThan(0);

  await window.keyboard.press('End');
  const last = menu.getByRole('menuitem').last();
  await expect(last).toBeFocused();
  const lb = (await last.boundingBox())!;
  const mb = (await menu.boundingBox())!;
  expect(lb.y).toBeGreaterThanOrEqual(mb.y - 0.5);
  expect(lb.y + lb.height).toBeLessThanOrEqual(mb.y + mb.height + 0.5);
  await window.keyboard.press('Escape');
});
