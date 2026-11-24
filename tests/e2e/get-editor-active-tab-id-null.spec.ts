// 启动后无 tab → getEditorActiveTabId() = null;打开文件后 → 非 null(对照,证明读的是真实恢复 / 打开后的状态).
import { test as appTest, expect } from './fixtures/electron-app';
import { test as wsTest } from './fixtures/with-workspace';
import { waitForAppReady } from './helpers/app-ready';
import type { Page } from '@playwright/test';

async function activeTabId(window: Page): Promise<string | null> {
  return await window.evaluate(
    () =>
      globalThis.__continuoTest!.getEditorActiveTabId(),
  );
}

appTest('启动后 → getEditorActiveTabId 返回 null', async ({ window }) => {
  // 先等应用就绪(持久化恢复完成):activeTabId 初值即 null,就绪前读取区分不了「恢复后仍无 tab」。
  await waitForAppReady(window);
  expect(await activeTabId(window)).toBeNull();
});

wsTest('打开文件后 → getEditorActiveTabId 非 null(对照)', async ({ window }) => {
  await waitForAppReady(window);
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });
  await expect.poll(() => activeTabId(window)).not.toBeNull();
});
