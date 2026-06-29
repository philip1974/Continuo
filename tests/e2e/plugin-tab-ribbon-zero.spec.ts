// Plugin tab fresh state:Ribbon 图标 / Editor Action 数 = 0(无 plugin).
import { test, expect } from './fixtures/electron-app';
import {
  PLUGINS_TAB,
  openSettingsTab,
  pluginContributionCount,
} from './helpers/settings';

const RIBBON_LABELS = ['Ribbon 图标', 'Ribbon icons', 'Ribbon 아이콘'];
const EDITOR_ACTION_LABELS = ['Editor Action', 'Editor Actions'];

test('Plugin tab fresh:Ribbon/Editor Action count=0', async ({ window }) => {
  await openSettingsTab(window, PLUGINS_TAB);

  // 找具体行的 count cell
  const ribbonCount = await pluginContributionCount(window, RIBBON_LABELS);
  expect(ribbonCount).toBe(0);

  const editorActionCount = await pluginContributionCount(window, EDITOR_ACTION_LABELS);
  expect(editorActionCount).toBe(0);
});
