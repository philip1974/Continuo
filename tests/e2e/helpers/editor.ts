import { expect, type Locator, type Page } from '@playwright/test';
import { expandTreeItem, openTreeItem } from './explorer';

export const EDITOR_NO_FILE_OPEN = /^(未打开文件|No file open|열린 파일 없음)$/;
export const EDITOR_NO_FILE_OPEN_TEXT = /(未打开文件|No file open|열린 파일 없음)/;
// 多个编辑器组时名称带组号「编辑器标签，编辑器组 N」(122b7004);单组时不带。
export const EDITOR_TABS = /^(编辑器标签|Editor tabs|편집기 탭)(，编辑器组 \d+|, Editor Group \d+|, 편집기 그룹 \d+)?$/;
export const EDITOR_SAVE_LABEL = /^(保存|Save|저장)$/;
export const EDITOR_MODE_EDIT = /^(编辑|Edit|편집)$/;
export const EDITOR_MODE_SOURCE = /^(源码|Source|소스)$/;
export const EDITOR_MODE_PREVIEW = /^(预览|Preview|미리보기)$/;
export const EDITOR_CLOSE_README_MD = /^(关闭 README\.md|Close README\.md|README\.md 닫기)$/;
export const EDITOR_CLOSE_A_TS = /^(关闭 a\.ts|Close a\.ts|a\.ts 닫기)$/;
export const EDITOR_CLOSE_B_TS = /^(关闭 b\.ts|Close b\.ts|b\.ts 닫기)$/;
export const DOCK_EMPTY_MESSAGE =
  /(所有面板都关掉了|All panels are closed|모든 패널이 닫혀 있습니다)/;
export const DOCK_RESTORE_DEFAULT_LAYOUT =
  /^(恢复默认布局|Restore default layout|기본 레이아웃 복원)$/;
export const DOCK_CLOSE_EDITOR =
  /^(关闭 (编辑器|Editor)|Close (编辑器|Editor)|(편집기|Editor) 닫기)$/;
// 终端 tab 标题 = 前台进程名(shell 空闲时即 shell 名,VSCode `${process}`);进程名未知时为默认名「终端 N」(terminal-title)。
const TERMINAL_TITLE = String.raw`(?:(?:Terminal|终端|터미널) \d+|zsh|bash|fish|sh|dash|pwsh|powershell|cmd)`;
export const DOCK_CLOSE_TERMINAL = new RegExp(`^(关闭 ${TERMINAL_TITLE}|Close ${TERMINAL_TITLE}|${TERMINAL_TITLE} 닫기)$`);
export const DOCK_CLOSE_BUTTON = /^(关闭 .+|Close .+|.+ 닫기)$/;
export const DOCK_POPOUT = /^(弹出到独立窗口|Pop out to standalone window|독립 창으로 팝아웃)$/;
// 终端输入框可访问名(VSCode「Terminal 1, zsh」):「Terminal N, 标题」/「终端 N，标题」/「터미널 N, 标题」;标题即默认名时只「终端 N」;无序号「终端，标题」。
export const TERMINAL_INPUT = /^(?:Terminal|终端|터미널)(?: \d+|[,，])/;
export const TERMINAL_PANEL_TAB = new RegExp(`^${TERMINAL_TITLE}(?= |$)`);
// 关闭脏 tab 的 VSCode 式确认框「是否要保存对 X 的更改?」+ 保存 / 不保存 / 取消。
export const EDITOR_SAVE_CHANGES_TITLE =
  /(是否要保存对「.+」的更改？|Do you want to save the changes you made to .+\?|.+의 변경 내용을 저장하시겠습니까\?)/;
export const EDITOR_DONT_SAVE = /^(不保存|Don't Save|저장 안 함)$/;
export const EDITOR_SAVE = /^(保存|Save|저장)$/;
export const EDITOR_CANCEL = /(取消|Cancel|취소)/;

export const EDITOR_UNSAVED_CHANGES_SELECTOR = [
  '[aria-label="未保存的更改"]',
  '[aria-label="Unsaved changes"]',
  '[aria-label="저장되지 않은 변경 사항"]',
].join(', ');

export function editorModeButton(window: Page, name: string | RegExp): Locator {
  return window.locator('main').getByRole('radio', { name }).first();
}

export function editorTab(window: Page, name: string | RegExp): Locator {
  return window
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByRole('tab')
    .filter({ hasText: name })
    .first();
}

export function editorTabItem(window: Page, name: string | RegExp): Locator {
  return window
    .getByRole('tablist', { name: EDITOR_TABS })
    .locator('div.wm-tab-nav-item')
    .filter({ hasText: name })
    .first();
}

export async function openWorkspaceFile(
  window: Page,
  pathSegments: readonly string[],
): Promise<void> {
  if (pathSegments.length === 0) {
    throw new Error('openWorkspaceFile requires at least one path segment');
  }
  for (const segment of pathSegments.slice(0, -1)) {
    await expandTreeItem(window, new RegExp(`^${escapeRegExp(segment)}$`));
  }
  const fileName = pathSegments[pathSegments.length - 1]!;
  await openTreeItem(window, new RegExp(`^${escapeRegExp(fileName)}$`));
  await expect(window.locator('header').first()).toContainText(fileName, {
    timeout: 10_000,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
