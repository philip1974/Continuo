// Plugin tab 「面板类型」 count = 7 (editor/terminal/output/settings/debug/search/conflict-diff;ba2b5e8e 新增「在文件中查找」面板,
// b64e3a92 新增 hidden 的合并冲突对比面板 conflict-diff —— hidden 只是不进「打开视图」菜单,仍是注册的面板类型).
import { test, expect } from './fixtures/electron-app';
import {
  PLUGINS_TAB,
  openSettingsTab,
  pluginContributionCount,
} from './helpers/settings';

const PANEL_TYPE_LABELS = ['面板类型', 'Panel types', '패널 유형'];

test('面板类型 count = 7', async ({ window }) => {
  await openSettingsTab(window, PLUGINS_TAB);
  const count = await pluginContributionCount(window, PANEL_TYPE_LABELS);

  expect(count).toBe(7);
});
