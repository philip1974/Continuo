// Settings 搜索 description 中的关键字 → 匹配命中.
import { test, expect } from './fixtures/electron-app';
import {
  MATCHED_SETTINGS,
  openSettings,
  settingsSearch,
} from './helpers/settings';

// 只出现在 description 里的词(标题「字号 / Font size」不含):按界面语言(<html lang>)取。
const DESCRIPTION_ONLY_TERM: Record<string, string> = { en: 'xterm', 'zh-CN': '重排', ko: '다시 배치' };

test('搜索 description 独有关键词 → terminal.integrated.fontSize 匹配', async ({ window }) => {
  await openSettings(window);

  const lang = await window.evaluate(() => document.documentElement.lang);
  const search = settingsSearch(window);
  await search.fill(DESCRIPTION_ONLY_TERM[lang] ?? 'xterm');

  // 主区域显「匹配 N 项」+ 含 fontSize chip
  await expect(window.getByText(MATCHED_SETTINGS)).toBeVisible({
    timeout: 5_000,
  });
  await expect(
    window.locator('main code').filter({ hasText: 'terminal.integrated.fontSize' }),
  ).toBeVisible();
});
