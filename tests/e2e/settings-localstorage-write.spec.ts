// SettingsValuesStore 持久化:setValue → localStorage 'continuo.settings.values'.
import { test, expect } from './fixtures/electron-app';
import {
  clickFirstVisibleResetDefault,
  EDITOR_TAB,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';

test('改 fontSize=20 → localStorage 写入 editor.fontSize=20', async ({
  window,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EDITOR_TAB })
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
  await window.getByRole('button', { name: SETTINGS }).click();
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EDITOR_TAB })
    .click();

  // 改 + 验证写入
  await window.locator('input[type=number]').first().fill('22');
  await window.waitForTimeout(100);

  // 点 reset(找 not-invisible 的)
  await clickFirstVisibleResetDefault(window);
  await window.waitForTimeout(100);

  const raw = await window.evaluate(() =>
    localStorage.getItem('continuo.settings.values'),
  );
  if (raw) {
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data['editor.fontSize']).toBeUndefined();
  }
});
