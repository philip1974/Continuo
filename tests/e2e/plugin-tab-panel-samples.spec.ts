// Plugins tab 「Panel 类型」行 samples 含 editor/terminal/output/settings.
import { test, expect } from './fixtures/electron-app';

test('Panel 类型 samples 含核心 panel ids', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '插件', exact: true })
    .click();

  await expect(window.locator('text=Panel 类型')).toBeVisible({
    timeout: 10_000,
  });

  // 找 'Panel 类型' 行的 samples 单元格
  const samplesText = await window.locator('main').evaluate((root) => {
    const rows = Array.from(root.querySelectorAll('div')).filter((d) =>
      Array.from(d.children).some(
        (c) =>
          c.textContent?.trim() === 'Panel 类型' &&
          c.classList.contains('w-32'),
      ),
    );
    if (rows.length === 0) return '';
    // samples 是行内最后一个 text 节点(after w-32 + tabular-nums.w-8)
    return rows[0]!.textContent ?? '';
  });

  expect(samplesText).toContain('editor');
  expect(samplesText).toContain('terminal');
  expect(samplesText).toContain('output');
  expect(samplesText).toContain('settings');
});
