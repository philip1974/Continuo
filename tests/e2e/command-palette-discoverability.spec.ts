// 命令可发现性(BDD: src/__tests__/command-discoverability/):菜单 / 标题栏里的动作在命令面板里可搜可执行
//(按英文标题搜:非英文界面也匹配英文原名)。
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/electron-app';
import { COMMAND_LIST, commandPaletteInput, openCommandPalette, quickOpenInput } from './helpers/palette';
import { OUTPUT_EMPTY } from './helpers/output';

async function runFromPalette(window: Page, query: string, title: RegExp): Promise<void> {
  await openCommandPalette(window);
  const input = commandPaletteInput(window);
  await input.fill(query);
  const option = window.getByRole('listbox', { name: COMMAND_LIST }).getByRole('option').filter({ hasText: title });
  await expect(option).toHaveCount(1);
  await option.click();
  await expect(input).toBeHidden({ timeout: 5_000 });
}

test('转到文件… → 打开 Quick Open', async ({ window }) => {
  await runFromPalette(window, 'Go to File', /^(转到文件…|Go to File…|파일로 이동…)/);
  await expect(quickOpenInput(window)).toBeVisible({ timeout: 5_000 });
});

test('显示输出 → 打开输出面板', async ({ window }) => {
  await runFromPalette(window, 'Show Output', /(显示输出|Show Output|출력 표시)/);
  await expect(window.getByText(OUTPUT_EMPTY)).toBeVisible({ timeout: 10_000 });
});

// 缩放命令带默认键(行尾是键位切片),标题不以 $ 锚定。见 src/__tests__/window-zoom/
test('放大 / 重置缩放 → 改设置 window.zoomLevel,窗口随之缩放', async ({ window }) => {
  const ratio = (): Promise<number> => window.evaluate(() => globalThis.devicePixelRatio);
  const before = await ratio();
  await runFromPalette(window, 'Zoom In', /(放大（缩放）|Zoom In|확대)/);
  await expect.poll(ratio).toBeGreaterThan(before);
  await runFromPalette(window, 'Reset Zoom', /(重置缩放|Reset Zoom|확대\/축소 초기화)/);
  await expect.poll(ratio).toBe(before);
});
