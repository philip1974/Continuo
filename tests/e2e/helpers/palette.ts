import { expect, type Locator, type Page } from '@playwright/test';
import { dispatchModKey } from './hotkeys';

const SETTINGS_BUTTON = /^(设置|Settings|설정)$/;
export const COMMAND_SEARCH = /^(输入命令名…|Type a command…|명령어 입력…)$/;
export const COMMAND_LIST = /^(命令列表|Command list|명령어 목록)$/;
export const COMMAND_NO_MATCH = /(无匹配命令|No matching command|일치하는 명령어 없음)/;
export const QUICK_OPEN_SEARCH = /^(搜索文件|Search files|파일 검색)$/;
export const QUICK_OPEN_PLACEHOLDER = /(搜索文件名|Search file name|파일 이름)/;
export const QUICK_OPEN_NO_WORKSPACE =
  /(请先在资源管理器中打开工作区|Please open a workspace in Explorer first|먼저 탐색기에서 워크스페이스를 여세요)/;
const SETTINGS_COMMAND_TITLE = /(打开设置|Open Settings|설정 열기)/;

async function waitForShell(window: Page): Promise<void> {
  await expect(window.getByRole('button', { name: SETTINGS_BUTTON })).toBeVisible({
    timeout: 10_000,
  });
}

export async function openCommandPalette(window: Page): Promise<void> {
  await waitForShell(window);
  await dispatchModKey(window, 'p', { shift: true });
  await expect(commandPaletteInput(window)).toBeVisible({ timeout: 5_000 });
}

export async function openQuickOpen(window: Page): Promise<void> {
  await waitForShell(window);
  await dispatchModKey(window, 'p');
  await expect(quickOpenInput(window)).toBeVisible({ timeout: 5_000 });
}

export function commandPaletteInput(window: Page): Locator {
  return window.getByRole('combobox', { name: COMMAND_SEARCH });
}

export function quickOpenInput(window: Page): Locator {
  return window.locator(
    [
      '.wm-modal-content input[aria-label="搜索文件"]',
      '.wm-modal-content input[aria-label="Search files"]',
      '.wm-modal-content input[aria-label="파일 검색"]',
      '.wm-modal-content input[placeholder*="搜索文件名"]',
      '.wm-modal-content input[placeholder*="Search file name"]',
      '.wm-modal-content input[placeholder*="파일 이름"]',
    ].join(', '),
  );
}

export function settingsCommandOption(window: Page): Locator {
  return window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: SETTINGS_COMMAND_TITLE });
}

/**
 * 命令面板里按英文原名筛出「首选项: 打开设置」(非英文界面也按英文原名匹配)并返回该项。空查询的列表按标题排序、只渲染可见范围附近的行,
 * 新增命令会把它挤出渲染范围 —— 用例不依赖它在完整列表里的位置。
 */
export async function filterToSettingsCommand(window: Page): Promise<Locator> {
  await commandPaletteInput(window).fill('Open Settings');
  return settingsCommandOption(window);
}

const TOGGLE_SETTINGS_COMMAND_TITLE = /(切换设置|Toggle Settings|설정 전환)/;

/** 命令面板里按英文原名筛出 ⌘, 的「查看: 切换设置」(settings.toggle)并返回该项。 */
export async function filterToToggleSettingsCommand(window: Page): Promise<Locator> {
  await commandPaletteInput(window).fill('Toggle Settings');
  return window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: TOGGLE_SETTINGS_COMMAND_TITLE });
}

/** 列表行选中态:className 含独立的 `border-accent`(pickerRowClassName;未选中行是 `border-transparent`)。 */
export const ROW_SELECTED = /(^|\s)border-accent(\s|$)/;
