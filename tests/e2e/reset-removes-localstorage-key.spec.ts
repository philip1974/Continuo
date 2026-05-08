// reset 一个 override → localStorage values 中 key 删除.
import { test, expect } from './fixtures/electron-app';

test('改 fontSize=20 → reset → values 不含 editor.fontSize', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '编辑器', exact: true })
    .click();

  const fontInput = window.locator('input[type=number]').first();
  await fontInput.fill('20');
  await window.waitForTimeout(200);

  let stored = await window.evaluate(() =>
    localStorage.getItem('continuo.settings.values'),
  );
  expect(stored).toContain('"editor.fontSize":20');

  // reset
  await window.evaluate(() => {
    const btn = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="恢复默认"]',
      ),
    ).find((b) => !b.className.includes('invisible'));
    btn?.click();
  });
  await window.waitForTimeout(200);

  stored = await window.evaluate(() =>
    localStorage.getItem('continuo.settings.values'),
  );
  // editor.fontSize key 删除
  expect(stored ?? '').not.toContain('"editor.fontSize"');
});
