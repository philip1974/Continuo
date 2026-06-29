// Plugin tab 「设置 Tab」samples 含核心 tab ids.
import { test, expect } from './fixtures/electron-app';
import {
  PLUGINS_SETTING_TABS_LABELS,
  PLUGINS_TAB,
  pluginContributionRowText,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';

test('设置 Tab samples 含 core.general/core.editor', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: PLUGINS_TAB })
    .click();

  await expect(
    window.getByText(new RegExp(PLUGINS_SETTING_TABS_LABELS.join('|'))).first(),
  ).toBeVisible({
    timeout: 10_000,
  });

  const samplesText = await pluginContributionRowText(
    window,
    PLUGINS_SETTING_TABS_LABELS,
  );

  expect(samplesText).toContain('core.general');
  expect(samplesText).toContain('core.editor');
});
