// Plugin tab 「Panel 类型」 count = 4 (editor/terminal/output/settings).
import { test, expect } from './fixtures/electron-app';

test('Panel 类型 count = 4', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '插件', exact: true })
    .click();

  const count = await window.locator('main').evaluate((root) => {
    const rows = Array.from(root.querySelectorAll('div')).filter((d) =>
      Array.from(d.children).some(
        (c) =>
          c.textContent?.trim() === 'Panel 类型' &&
          c.classList.contains('w-32'),
      ),
    );
    if (rows.length === 0) return -1;
    const numCell = rows[0]!.querySelector('div.tabular-nums');
    return Number(numCell?.textContent?.trim() ?? '0');
  });

  expect(count).toBe(4);
});
