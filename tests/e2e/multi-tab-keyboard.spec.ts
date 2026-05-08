// Cmd+Click TabNav item 中键 / TabNav 切 tab 用键盘 — Continuo TabNavItem
// 是 button role=tab,Tab 键导航 + Enter 选中.
import { test, expect } from './fixtures/with-workspace';

test('TabNav: 点 a.ts tab → tab role=tab + aria-selected=true', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('main [role=tablist]').first()).toBeVisible();

  // 点 README.md tab
  const readmeTab = window
    .locator('main [role=tablist]')
    .first()
    .locator('[role=tab]')
    .filter({ hasText: 'README.md' });
  await readmeTab.click();
  await expect(readmeTab).toHaveAttribute('aria-selected', 'true');

  const aTab = window
    .locator('main [role=tablist]')
    .first()
    .locator('[role=tab]')
    .filter({ hasText: 'a.ts' });
  await expect(aTab).toHaveAttribute('aria-selected', 'false');
});

test.skip('Tab 中键关闭(button=1 pointerup)', async ({ window }) => {
  // 跳过原因:Playwright 的 mouse.down 不直接支持 'middle';dispatchEvent
  // PointerEvent button=1 在 React 树外发派,onPointerUp 路由到 SharedTab
  // 不可靠。SharedTab 单测已覆盖中键关闭逻辑.
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(
    window
      .locator('main [role=tablist]')
      .first()
      .locator('[role=tab]'),
  ).toHaveCount(2);

  // SharedTab 中键 close 路径:在 .group/tab(整个 tab 容器)上发 pointerdown(button=1)
  // + pointerup(button=1)
  const aTabBox = window
    .locator('main [role=tablist]')
    .first()
    .locator('[role=tab]')
    .filter({ hasText: 'a.ts' });

  const box = await aTabBox.boundingBox();
  if (!box) throw new Error('a.ts tab box missing');
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Playwright 的 mouse.down/up 通过 button 选项;但 'middle' 在 mouse.down 不直接支持,
  // 用 dispatchEvent 派发 pointerdown / pointerup with button=1 到 tab 容器
  // 通过 page.evaluate 直接在元素上 dispatch
  await window.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    el.dispatchEvent(
      new PointerEvent('pointerdown', {
        button: 1,
        bubbles: true,
        cancelable: true,
      }),
    );
    el.dispatchEvent(
      new PointerEvent('pointerup', {
        button: 1,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

  // 等动画
  await window.waitForTimeout(400);

  // a.ts tab 关闭 → 剩 README.md
  const tabs = window
    .locator('main [role=tablist]')
    .first()
    .locator('[role=tab]');
  // 单 tab 时回紧凑模式(无 tablist),所以可能 count=0
  const tabCount = await tabs.count();
  expect(tabCount).toBeLessThan(2);
});
