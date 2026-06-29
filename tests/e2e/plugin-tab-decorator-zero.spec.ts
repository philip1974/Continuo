// Plugin tab 「Explorer 装饰器」 fresh state count=0.
import { test, expect } from './fixtures/electron-app';
import {
  PLUGINS_TAB,
  openSettingsTab,
  pluginContributionCount,
} from './helpers/settings';

const EXPLORER_DECORATOR_LABELS = [
  'Explorer 装饰器',
  'Explorer decorators',
  'Explorer 장식자',
];

test('Explorer 装饰器 count = 0', async ({ window }) => {
  await openSettingsTab(window, PLUGINS_TAB);
  const count = await pluginContributionCount(window, EXPLORER_DECORATOR_LABELS);

  expect(count).toBe(0);
});
