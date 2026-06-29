import { expect, type Page } from '@playwright/test';

export const SETTINGS = /^(设置|Settings|설정)$/;
export const CLOSE_SETTINGS = /^(关闭 Settings|Close Settings|Settings 닫기)$/;
export const SETTINGS_NAV = /^(设置分类|Setting categories|설정 카테고리)$/;
export const SEARCH_SETTINGS = /^(搜索设置|Search settings|설정 검색)/;
export const GENERAL_TAB = /^(通用|General|일반)$/;
export const EDITOR_TAB = /^(编辑器|Editor|편집기)$/;
export const EXPLORER_TAB = /^(资源管理器|Explorer|탐색기)$/;
export const TERMINAL_TAB = /^(终端|Terminal|터미널)$/;
export const KEYBINDINGS_TAB = /^(快捷键|Keybindings|단축키)$/;
export const PLUGINS_TAB = /^(插件|Plugins|플러그인)$/;
export const MARKETPLACE_TAB = /^(插件商店|Plugin Market|플러그인 마켓)$/;
export const RESET_DEFAULT = /^(恢复默认|Reset to default|기본값으로 초기화)$/;
export const RESET_DEFAULT_TEXT = /(恢复默认|Reset to default|기본값으로 초기화)/;
export const RESET_DEFAULT_SELECTOR = [
  '[aria-label="恢复默认"]',
  '[aria-label="Reset to default"]',
  '[aria-label="기본값으로 초기화"]',
].join(', ');
export const SHOW_LINE_NUMBERS =
  /^(显示行号|Show line numbers|줄 번호 표시)$/;
export const THEME_SETTING = /^(主题|Theme|테마)$/;
export const FONT_SIZE_SETTING = /^(字号|Font size|글꼴 크기)$/;
export const LIGHT_THEME = /^(亮色|Light|라이트)$/;
export const DARK_THEME = /^(暗色|Dark|다크)$/;
export const SYSTEM_THEME = /^(跟随系统|System|시스템)$/;
export const AUTO_SAVE_MARKDOWN =
  /^(自动保存 Markdown|Auto-save Markdown|Markdown 자동 저장)$/;
export const KEYBINDINGS_TOTAL_SUMMARY =
  /(共\s*\d+\s*个有快捷键的命令|\d+\s*commands with hotkey|단축키가 있는 명령어\s*\d+개)/;
export const PLUGINS_SETTING_TABS_LABELS = [
  '设置 Tab',
  'Setting Tabs',
  '설정 탭',
] as const;
export const MARKETPLACE_READY =
  /(显示\s*\d+\s*\/\s*共\s*\d+\s*个插件|Showing\s*\d+\s*\/\s*\d+\s*plugins|\d+\s*\/\s*\d+\s*플러그인 표시|暂无插件|No plugins|플러그인 없음|拉取索引失败|Failed to fetch index|인덱스 가져오기 실패)/;
export const MARKETPLACE_INDEX_OK =
  /(显示\s*\d+\s*\/\s*共\s*\d+\s*个插件|Showing\s*\d+\s*\/\s*\d+\s*plugins|\d+\s*\/\s*\d+\s*플러그인 표시|暂无插件|No plugins|플러그인 없음)/;
export const MARKETPLACE_GIT_URL_INSTALL =
  /^(从 Git URL 安装|Install from Git URL|Git URL에서 설치)$/;
export const MARKETPLACE_GIT_URL_WARNING =
  /(第三方仓库可能存在安全风险|third-party repositories may have security risks|제3자 저장소는 보안 위험이 있을 수 있으니)/i;
export const MARKETPLACE_INSTALL_EXTENSION =
  /^(安装扩展|Install extension|확장 설치)$/;
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

export function resetDefaultButtons(window: Page) {
  return window.locator(RESET_DEFAULT_SELECTOR);
}

export async function visibleResetDefaultCount(window: Page): Promise<number> {
  return resetDefaultButtons(window).evaluateAll((buttons) =>
    buttons.filter((button) => !button.className.includes('invisible')).length,
  );
}

export async function clickFirstVisibleResetDefault(window: Page): Promise<void> {
  await resetDefaultButtons(window).evaluateAll((buttons) => {
    const button = buttons.find((b) => !b.className.includes('invisible'));
    if (button instanceof HTMLButtonElement) button.click();
  });
}

export async function pluginContributionRowText(
  window: Page,
  labels: readonly string[],
): Promise<string> {
  return window.locator('main').evaluate((root, rowLabels) => {
    const rows = Array.from(root.querySelectorAll('div')).filter((d) =>
      Array.from(d.children).some((c) => {
        const text = c.textContent?.trim() ?? '';
        return rowLabels.includes(text) && c.classList.contains('w-32');
      }),
    );
    return rows[0]?.textContent ?? '';
  }, labels);
}

export async function pluginContributionCount(
  window: Page,
  labels: readonly string[],
): Promise<number> {
  return window.locator('main').evaluate((root, rowLabels) => {
    const rows = Array.from(root.querySelectorAll('div')).filter((d) =>
      Array.from(d.children).some((c) => {
        const text = c.textContent?.trim() ?? '';
        return rowLabels.includes(text) && c.classList.contains('w-32');
      }),
    );
    if (rows.length === 0) return -1;
    const numCell = rows[0]!.querySelector('div.tabular-nums');
    return Number(numCell?.textContent?.trim() ?? '0');
  }, labels);
}
