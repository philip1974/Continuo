// Plugin tab 「设置 Tab」 计数 ≥ 6.
import { test, expect } from './fixtures/electron-app';
import {
  PLUGINS_SETTING_TABS_LABELS,
  PLUGINS_TAB,
  pluginContributionCount,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';

test('设置 Tab count ≥ 6(内置 6+ 个 tab)', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: PLUGINS_TAB })
    .click();

  const count = await pluginContributionCount(
    window,
    PLUGINS_SETTING_TABS_LABELS,
  );

  expect(count).toBeGreaterThanOrEqual(6);
});
