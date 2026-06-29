import type { Locator, Page } from '@playwright/test';

export const EXPLORER_NEW_FILE = /^(新建文件|New file|새 파일)$/;
export const EXPLORER_NEW_FOLDER = /^(新建文件夹|New folder|새 폴더)$/;
export const EXPLORER_REFRESH =
  /^(刷新资源管理器|Refresh|탐색기 새로 고침)$/;
export const EXPLORER_COLLAPSE_ALL = /^(折叠全部|Collapse all|모두 접기)$/;
export const EXPLORER_EXPAND_ALL = /^(展开全部|Expand all|모두 펼치기)$/;
export const EXPLORER_CLOSE_FOLDER =
  /^(关闭文件夹|Close folder|폴더 닫기)$/;
export const EXPLORER_OPEN_RECENT =
  /^(打开最近|Open recent|최근 항목 열기)$/;
export const EXPLORER_OPEN_FOLDER =
  /^(打开文件夹|Open Folder|폴더 열기)$/;
export const EXPLORER_NO_FOLDER_OPEN =
  /^(未打开文件夹|No folder open|열린 폴더 없음)$/;
export const EXPLORER_NO_FOLDER_OPEN_TEXT =
  /(未打开文件夹|No folder open|열린 폴더 없음)/;
export const EXPLORER_RECENT = /^(最近打开|Recent|최근 열기)$/;
export const EXPLORER_RECENT_TEXT = /(最近打开|Recent|최근 열기)/;
export const EXPLORER_RENAME = /(重命名|Rename|이름 바꾸기)/;
export const EXPLORER_TRASH = /(移到废纸篓|Move to Trash|휴지통으로 이동)/;
export const EXPLORER_MORE_ACTIONS =
  /^(更多操作|More actions|추가 작업)$/;

export function explorerSidebar(window: Page): Locator {
  return window.locator('main aside').nth(1);
}

export function explorerMoreActionsButton(window: Page): Locator {
  return explorerSidebar(window).getByRole('button', {
    name: EXPLORER_MORE_ACTIONS,
  });
}
