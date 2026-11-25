// 强制颜色(Windows 高对比度)下选中 / 当前 / 开关状态仍可辨:命令面板方向键选中项、Explorer 选中行、设置开关开 / 关
// 的计算样式与未选中 / 关闭态不同;正常模式不受影响。CSS 契约见 src/__tests__/forced-colors-states/。
import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { commandPaletteInput, COMMAND_LIST, openCommandPalette } from './helpers/palette';
import { EDITOR_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';

const outlineOf = (el: Locator) =>
  el.evaluate((n) => {
    const s = getComputedStyle(n);
    return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, borderLeft: s.borderLeftColor };
  });

test('强制颜色:命令面板选中项与 Explorer 选中行有 Highlight 轮廓,未选中项没有', async ({ window }) => {
  await window.emulateMedia({ forcedColors: 'active' });
  expect(await window.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);

  await openCommandPalette(window);
  await window.keyboard.press('ArrowDown');
  const options = window.getByRole('listbox', { name: COMMAND_LIST }).getByRole('option');
  const selected = window.getByRole('listbox', { name: COMMAND_LIST }).locator('[role=option][aria-selected=true]');
  await expect(selected).toHaveCount(1);
  const idle = options.and(window.locator('[aria-selected=false]')).first();
  const sel = await outlineOf(selected);
  const off = await outlineOf(idle);
  expect(sel.style).toBe('solid');
  expect(off.style).toBe('none');
  // 未选中行的透明占位竖条不显形:与面板背景同色(Canvas),而非 CanvasText
  const canvas = await idle.evaluate((n) => getComputedStyle(n.closest('[role=dialog]') ?? document.body).backgroundColor);
  expect(off.borderLeft).toBe(canvas);
  await window.keyboard.press('Escape');
  await expect(commandPaletteInput(window)).toBeHidden();

  const readme = window.getByRole('treeitem', { name: /README\.md/ });
  await readme.click();
  await expect(readme).toHaveAttribute('aria-selected', 'true');
  const other = window.locator('[role=treeitem][aria-selected=false]').first();
  const a = await outlineOf(readme);
  const b = await outlineOf(other);
  expect(a.style).not.toBe('none');
  expect(b.style).toBe('none');
});

test('强制颜色:设置开关开 / 关轨道底色不同,滑块与轨道可区分', async ({ window }) => {
  await window.emulateMedia({ forcedColors: 'active' });
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await nav.getByRole('button', { name: EDITOR_TAB }).click();
  // 设置导航当前项:aria-current → Highlight 轮廓;其它项无
  expect((await outlineOf(nav.locator('[aria-current=page]'))).style).toBe('solid');
  expect((await outlineOf(nav.locator('button:not([aria-current])').first())).style).toBe('none');

  const toggle = window.locator('button[role=switch]').first();
  const read = () =>
    toggle.evaluate((el) => ({
      track: getComputedStyle(el).backgroundColor,
      thumb: getComputedStyle(el.querySelector('.wm-switch__thumb')!).backgroundColor,
    }));
  await expect(toggle).toHaveAttribute('data-checked', 'true');
  const on = await read();
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-checked', 'false');
  const off = await read();
  expect(on.track).not.toBe(off.track);
  expect(on.thumb).not.toBe(on.track);
  expect(off.thumb).not.toBe(off.track);
});

test('正常模式:命令面板选中项不画强制颜色轮廓(规则只在 forced-colors 内)', async ({ window }) => {
  await window.emulateMedia({ forcedColors: 'none' });
  await openCommandPalette(window);
  const selected = window.getByRole('listbox', { name: COMMAND_LIST }).locator('[role=option][aria-selected=true]');
  await expect(selected).toHaveCount(1);
  expect((await outlineOf(selected)).style).toBe('none');
});
