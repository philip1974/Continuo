// BDD:src/__tests__/dock-group-scroll-containment —— 设置「插件」页滚到底再继续滚,dock 组(标签栏 + 搜索框)不被滚走。
// 「插件」页内容来自本地注册表(不依赖市场索引网络),且含 SR_ONLY_STYLE 的 role=status 文本(此前逃出滚动容器撑高 .dv-view)。
import { test, expect } from './fixtures/electron-app';
import { PLUGINS_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('插件页滚到底后继续滚:组视图 .dv-view 不滚动,标签栏留在原位', async ({ window, electronApp }) => {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    w.setMinimumSize(400, 270);
    w.setContentSize(1000, 560);
  });
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });
  await nav.getByRole('button', { name: PLUGINS_TAB }).click();

  const settingsTab = window.locator('.dv-tab', { hasText: /^(设置|Settings|설정)/ }).first();
  await expect(settingsTab).toBeVisible();
  const tabTop = (await settingsTab.boundingBox())!.y;

  // 在内容区上滚轮:先滚到内容底,再继续滚(此前接力滚动 .dv-view)。
  const content = nav.locator('xpath=following-sibling::div[1]');
  const box = (await content.boundingBox())!;
  await window.mouse.move(box.x + box.width - 40, box.y + box.height / 2);
  // 逐次滚并让出一帧:连发的 wheel 在合成器里会被合并 / 丢弃,内容滚不到底。
  for (let i = 0; i < 20; i += 1) {
    await window.mouse.wheel(0, 400);
    await window.waitForTimeout(30);
  }
  await window.waitForTimeout(300);
  // 前置:内容确实可滚且已滚到底(否则本用例测不到接力滚动)。
  expect(await content.evaluate((el) => el.scrollHeight > el.clientHeight && el.scrollTop > 0)).toBe(true);

  const views = await window.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.dv-split-view-container > .dv-view-container > .dv-view')].map(
      (v) => ({ top: v.scrollTop, overflow: v.scrollHeight - v.clientHeight }),
    ),
  );
  expect(views.length).toBeGreaterThan(0);
  for (const v of views) expect(v.top).toBe(0);
  expect((await settingsTab.boundingBox())!.y).toBe(tabTop);
});
