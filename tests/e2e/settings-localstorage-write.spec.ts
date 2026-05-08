// SettingsValuesStore 持久化:setValue → localStorage 'continuo.settings.values'.
import { test, expect } from './fixtures/electron-app';

test('改 fontSize=20 → localStorage 写入 editor.fontSize=20', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '编辑器', exact: true })
    .click();

  await window.locator('input[type=number]').first().fill('20');
  // 等 store 写盘(同步)
  await window.waitForTimeout(100);

  const raw = await window.evaluate(() =>
    localStorage.getItem('continuo.settings.values'),
  );
  expect(raw).not.toBeNull();
  const data = JSON.parse(raw!) as Record<string, unknown>;
  expect(data['editor.fontSize']).toBe(20);
});

test('reset fontSize → localStorage 删 key', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '编辑器', exact: true })
    .click();

  // 改 + 验证写入
  await window.locator('input[type=number]').first().fill('22');
  await window.waitForTimeout(100);

  // 点 reset(找 not-invisible 的)
  await window.evaluate(() => {
    const btn = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="恢复默认"]',
      ),
    ).find((b) => !b.className.includes('invisible'));
    btn?.click();
  });
  await window.waitForTimeout(100);

  const raw = await window.evaluate(() =>
    localStorage.getItem('continuo.settings.values'),
  );
  if (raw) {
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data['editor.fontSize']).toBeUndefined();
  }
});
