// TitleBar(顶部 header)高度 36px(h-9 = 2.25rem).
import { test, expect } from './fixtures/electron-app';

test('TitleBar 高度近 36px', async ({ window }) => {
  const titleBar = window.locator('header').first();
  await expect(titleBar).toBeVisible({ timeout: 5_000 });
  const box = await titleBar.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(34);
  expect(box!.height).toBeLessThanOrEqual(38);
});

// macOS hiddenInset:界面缩放(⌘- / ⌘+)时标题栏实际高度不变,红绿灯不伸出(VSCode titlebarPart counter-zoom)。
// BDD: src/__tests__/title-bar/ 「界面缩放(macOS)」
test('macOS:缩小 / 放大界面后标题栏的屏幕高度仍近 36px', async ({ electronApp, window }) => {
  test.skip(process.platform !== 'darwin', 'hiddenInset 红绿灯只在 macOS');
  const titleBar = window.locator('header').first();
  await expect(titleBar).toBeVisible({ timeout: 5_000 });
  for (const factor of [0.67, 1.5]) {
    await electronApp.evaluate(({ BrowserWindow }, f) => {
      BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(f);
    }, factor);
    // 屏幕高度 = CSS 高度 × 页面缩放系数
    await expect
      .poll(async () => Math.round(((await titleBar.boundingBox())?.height ?? 0) * factor), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(34);
    await expect
      .poll(async () => Math.round(((await titleBar.boundingBox())?.height ?? 0) * factor), { timeout: 5_000 })
      .toBeLessThanOrEqual(38);
  }
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1));
});
