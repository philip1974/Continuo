// Plugin tab 「面板类型」 count = 5 (editor/terminal/output/settings/debug).
import { test, expect } from './fixtures/electron-app';
import {
  PLUGINS_TAB,
  openSettingsTab,
  pluginContributionCount,
} from './helpers/settings';

const PANEL_TYPE_LABELS = ['面板类型', 'Panel types', '패널 유형'];

test('面板类型 count = 5', async ({ window }) => {
  await openSettingsTab(window, PLUGINS_TAB);
  const count = await pluginContributionCount(window, PANEL_TYPE_LABELS);

  expect(count).toBe(5);
});
