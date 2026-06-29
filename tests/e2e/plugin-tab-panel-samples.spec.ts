// Plugins tab 「Panel 类型」行 samples 含 core panel ids.
import { test, expect } from './fixtures/electron-app';
import {
  PLUGINS_TAB,
  openSettingsTab,
  pluginContributionRowText,
} from './helpers/settings';

const PANEL_TYPE_LABELS = ['Panel 类型', 'Panel types', 'Panel 유형'];
const PANEL_TYPES = /^(Panel 类型|Panel types|Panel 유형)$/;

test('Panel 类型 samples 含核心 panel ids', async ({ window }) => {
  await openSettingsTab(window, PLUGINS_TAB);

  await expect(window.getByText(PANEL_TYPES)).toBeVisible({
    timeout: 10_000,
  });

  // 找 'Panel 类型' 行的 samples 单元格
  const samplesText = await pluginContributionRowText(window, PANEL_TYPE_LABELS);

  expect(samplesText).toContain('editor');
  expect(samplesText).toContain('terminal');
  expect(samplesText).toContain('output');
  expect(samplesText).toContain('settings');
  expect(samplesText).toContain('debug');
});
