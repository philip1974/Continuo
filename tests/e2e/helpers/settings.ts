import { expect, type Page } from '@playwright/test';

export const SETTINGS = /^(设置|Settings|설정)$/;
export const CLOSE_SETTINGS = /^(关闭 Settings|Close Settings|Settings 닫기)$/;
export const SETTINGS_NAV = /^(设置分类|Setting categories|설정 카테고리)$/;
export const SEARCH_SETTINGS = /^(搜索设置|Search settings|설정 검색)/;
export const EDITOR_TAB = /^(编辑器|Editor|편집기)$/;
export const TERMINAL_TAB = /^(终端|Terminal|터미널)$/;
export const KEYBINDINGS_TAB = /^(快捷键|Keybindings|단축키)$/;
export const MATCHED_SETTINGS =
  /匹配\s+\d+\s+项|Matched\s+\d+\s+for|에 대해\s+\d+개 일치/;
export const NO_MATCH_SETTINGS =
  /未找到匹配|No settings matched|일치하는 설정을 찾을 수 없음/;

export async function openSettings(window: Page): Promise<void> {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(
    window.getByRole('navigation', { name: SETTINGS_NAV }),
  ).toBeVisible({
    timeout: 10_000,
  });
}

export function settingsSearch(window: Page) {
  return window.getByRole('textbox', { name: SEARCH_SETTINGS });
}

export async function openSettingsTab(
  window: Page,
  name: RegExp,
): Promise<void> {
  await openSettings(window);
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name })
    .click();
}
