// Plugin tab 「设置 Tab」samples 含核心 tab ids.
import { test, expect } from './fixtures/electron-app';

test('设置 Tab samples 含 core.general/core.editor', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '插件', exact: true })
    .click();

  await expect(window.locator('text=设置 Tab').first()).toBeVisible({
    timeout: 10_000,
  });

  const samplesText = await window.locator('main').evaluate((root) => {
    const rows = Array.from(root.querySelectorAll('div')).filter((d) =>
      Array.from(d.children).some(
        (c) =>
          c.textContent?.trim() === '设置 Tab' &&
          c.classList.contains('w-32'),
      ),
    );
    if (rows.length === 0) return '';
    return rows[0]!.textContent ?? '';
  });

  expect(samplesText).toContain('core.general');
  expect(samplesText).toContain('core.editor');
});
