import { expect, type Locator, type Page } from '@playwright/test';
import { dispatchModKey } from './hotkeys';

const SETTINGS_BUTTON = /^(设置|Settings|설정)$/;
export const COMMAND_SEARCH = /^(输入命令名…|Type a command…|명령어 입력…)$/;
export const COMMAND_LIST = /^(命令列表|Command list|명령어 목록)$/;
export const COMMAND_NO_MATCH = /(无匹配命令|No matching command|일치하는 명령어 없음)/;
export const QUICK_OPEN_SEARCH = /^(搜索文件|Search files|파일 검색)$/;
export const QUICK_OPEN_PLACEHOLDER = /(搜索文件名|Search file name|파일 이름)/;
export const QUICK_OPEN_NO_WORKSPACE =
  /(请先在 Explorer 打开工作区|Please open a workspace in Explorer first|먼저 Explorer에서 워크스페이스를 여세요)/;
export const SETTINGS_COMMAND_TITLE = /(切换 Settings|Toggle Settings|설정 토글)/;

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
