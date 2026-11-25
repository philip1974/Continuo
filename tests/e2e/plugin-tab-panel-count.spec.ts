// Plugin tab 「面板类型」 count = 6 (editor/terminal/output/settings/debug/search;ba2b5e8e 新增「在文件中查找」面板).
import { test, expect } from './fixtures/electron-app';
import {
  PLUGINS_TAB,
  openSettingsTab,
  pluginContributionCount,
} from './helpers/settings';

const PANEL_TYPE_LABELS = ['面板类型', 'Panel types', '패널 유형'];

test('面板类型 count = 6', async ({ window }) => {
  await openSettingsTab(window, PLUGINS_TAB);
  const count = await pluginContributionCount(window, PANEL_TYPE_LABELS);

  expect(count).toBe(6);
});
