// SettingItemSpec.group 字段 → CategoryTabContent 渲染 h3 group header.
// 编辑器 tab 内有「外观」「自动保存」两组 + 默认 bucket(无 header).
import { test, expect } from './fixtures/electron-app';
import { EDITOR_TAB, openSettingsTab } from './helpers/settings';

const APPEARANCE = /^(外观|Appearance|모양)$/;
const AUTOSAVE = /^(自动保存|Auto-save|자동 저장)$/;

test('编辑器 tab 显示「外观」「自动保存」group h3 header', async ({
  window,
}) => {
  await openSettingsTab(window, EDITOR_TAB);

  // h3 集合中包含「外观」「自动保存」
  const headers = window.locator('main h3');
  await expect(headers.filter({ hasText: APPEARANCE })).toBeVisible();
  await expect(headers.filter({ hasText: AUTOSAVE })).toBeVisible();
});
