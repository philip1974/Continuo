// 开 3 tabs → 关中间一个 → 剩 2 tabs,顺序保留.
import { test, expect } from './fixtures/with-workspace';

test('开 README → a.ts → b.ts → 关中间 a.ts → 剩 README + b.ts', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await window.locator('text=b.ts').first().click();

  const items = window
    .locator('main [role=tablist]')
    .first()
    .locator('div.wm-tab-nav-item');
  await expect(items).toHaveCount(3, { timeout: 10_000 });

  // 三个 tab 顺序:README.md, a.ts, b.ts(打开顺序追加)
  const labels0 = await items.allTextContents();
  const order0 = labels0.map((s) => s.trim().replace(/✕$/, ''));
  expect(order0).toEqual(['README.md', 'a.ts', 'b.ts']);

  // 关 a.ts
  await window
    .locator('button[aria-label*="Close"][aria-label*="a.ts"]')
    .click();
  await expect(items).toHaveCount(2, { timeout: 5_000 });

  const labels1 = await items.allTextContents();
  const order1 = labels1.map((s) => s.trim().replace(/✕$/, ''));
  expect(order1).toEqual(['README.md', 'b.ts']);
});
