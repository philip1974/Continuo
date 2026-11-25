// 矮窗口下 Quick Open / 命令面板不越出窗口:输入框与对话框都在视口内(VSCode Quick Input 列表随窗口高度收缩)。
// BDD: src/__tests__/design-system-modal/(视口)
import { test, expect } from './fixtures/electron-app';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { commandPaletteInput, openCommandPalette, openQuickOpen, quickOpenInput } from './helpers/palette';

async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setContentSize(w!, h!), [width, height]);
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(height);
}

async function expectInViewport(page: Page, el: Locator): Promise<void> {
  const box = await el.boundingBox();
  const vh = await page.evaluate(() => window.innerHeight);
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vh);
}

for (const [width, height] of [
  [600, 400],
  [400, 300],
]) {
  test(`${width}×${height}:Quick Open 与命令面板的输入框、对话框都在窗口内`, async ({ electronApp, window }) => {
    await resize(electronApp, window, width!, height!);

    await openQuickOpen(window);
    await expectInViewport(window, quickOpenInput(window));
    await expectInViewport(window, window.locator('.wm-modal-content'));
    await window.keyboard.press('Escape');
    await expect(window.locator('.wm-modal-content')).toHaveCount(0);

    await openCommandPalette(window);
    await expectInViewport(window, commandPaletteInput(window));
    await expectInViewport(window, window.locator('.wm-modal-content'));
  });
}
