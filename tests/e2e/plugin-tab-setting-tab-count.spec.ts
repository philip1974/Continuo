// Plugin tab 「设置 Tab」 计数 ≥ 6.
import { test, expect } from './fixtures/electron-app';

test('设置 Tab count ≥ 6(内置 6+ 个 tab)', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '插件', exact: true })
    .click();

  const count = await window.locator('main').evaluate((root) => {
    const rows = Array.from(root.querySelectorAll('div')).filter((d) =>
      Array.from(d.children).some(
        (c) =>
          c.textContent?.trim() === '设置 Tab' &&
          c.classList.contains('w-32'),
      ),
    );
    if (rows.length === 0) return -1;
    const numCell = rows[0]!.querySelector('div.tabular-nums');
    return Number(numCell?.textContent?.trim() ?? '0');
  });

  expect(count).toBeGreaterThanOrEqual(6);
});
