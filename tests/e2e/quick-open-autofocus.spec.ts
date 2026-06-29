// Cmd+P 打开 → 焦点直接在搜索 input(可立刻输入).
import { test, expect } from './fixtures/electron-app';
import {
  commandPaletteInput,
  openCommandPalette,
  openQuickOpen,
  quickOpenInput,
} from './helpers/palette';

test('Cmd+P 后 → 搜索 input 已聚焦', async ({ window }) => {
  await openQuickOpen(window);
  // 等 modal 渲(Modal raf focus)
  const input = quickOpenInput(window);
  await expect(input).toBeVisible({ timeout: 5_000 });

  // activeElement 是该 input
  const ariaLabel = await window.evaluate(() => {
    const el = document.activeElement as HTMLInputElement | null;
    return el?.getAttribute('aria-label') ?? null;
  });
  await expect(input).toBeFocused();
  expect(ariaLabel).toMatch(/^(搜索文件|Search files|파일 검색)$/);
});

test('Cmd+Shift+P 后 → 命令面板 input 已聚焦', async ({ window }) => {
  await openCommandPalette(window);
  const input = commandPaletteInput(window);
  await expect(input).toBeVisible({ timeout: 5_000 });

  const ariaLabel = await window.evaluate(() => {
    const el = document.activeElement as HTMLInputElement | null;
    return el?.getAttribute('aria-label') ?? null;
  });
  await expect(input).toBeFocused();
  expect(ariaLabel).toMatch(/^(输入命令名…|Type a command…|명령어 입력…)$/);
});
