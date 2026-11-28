// SettingsValuesStore 持久化:setValue → localStorage 'continuo.settings.values'.
import { test, expect } from './fixtures/electron-app';
import {
  clickFirstVisibleResetDefault,
  EDITOR_TAB,
  SETTINGS,
  SETTINGS_NAV,
  settingNumberInput,
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

  await settingNumberInput(window, 'editor.fontSize').fill('20');
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

  // 改 + 验证写入(否则下面「reset 后 key 不在」可能是因为根本没写进去)
  await settingNumberInput(window, 'editor.fontSize').fill('22');
  await expect
    .poll(() =>
      window.evaluate(() => {
        const r = localStorage.getItem('continuo.settings.values');
        return r ? (JSON.parse(r) as Record<string, unknown>)['editor.fontSize'] : undefined;
      }),
    )
    .toBe(22);

  // 点 reset(找 not-invisible 的)
  await clickFirstVisibleResetDefault(window);

  await expect
    .poll(() =>
      window.evaluate(() => {
        const r = localStorage.getItem('continuo.settings.values');
        return r ? 'editor.fontSize' in (JSON.parse(r) as Record<string, unknown>) : false;
      }),
    )
    .toBe(false);
});
