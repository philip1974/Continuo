// fresh state → StatusBar 项 count = 0(无 plugin 注册).
import { test, expect } from './fixtures/electron-app';
import {
  PLUGINS_TAB,
  openSettingsTab,
  pluginContributionCount,
} from './helpers/settings';

const STATUSBAR_LABELS = ['StatusBar 项', 'StatusBar items', 'StatusBar 항목'];

test('StatusBar 项 count = 0', async ({ window }) => {
  await openSettingsTab(window, PLUGINS_TAB);
  const count = await pluginContributionCount(window, STATUSBAR_LABELS);

  expect(count).toBe(0);
});
