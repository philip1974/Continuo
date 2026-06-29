export const EDITOR_NO_FILE_OPEN =
  /^(未打开文件|No file open|열린 파일 없음)$/;
export const EDITOR_NO_FILE_OPEN_TEXT =
  /(未打开文件|No file open|열린 파일 없음)/;
export const EDITOR_TABS = /^(编辑器标签|Editor tabs|편집기 탭)$/;
export const EDITOR_WELCOME_HINT =
  /(在\s*Explorer\s*单击文件打开|Click a file in Explorer|탐색기에서 파일을 클릭하여 열기)/;
export const EDITOR_SAVE_LABEL = /^(保存|Save|저장)$/;
export const EDITOR_SAVE_TEXT = /(保存|Save|저장)/;
export const EDITOR_CLOSE_README_MD =
  /^(关闭 README\.md|Close README\.md|README\.md 닫기)$/;
export const EDITOR_CLOSE_A_TS = /^(关闭 a\.ts|Close a\.ts|a\.ts 닫기)$/;
export const EDITOR_CLOSE_B_TS = /^(关闭 b\.ts|Close b\.ts|b\.ts 닫기)$/;
export const DOCK_EMPTY_MESSAGE =
  /(所有面板都关掉了|All panels are closed|모든 패널이 닫혀 있습니다)/;
export const DOCK_RESTORE_DEFAULT_LAYOUT =
  /^(恢复默认布局|Restore default layout|기본 레이아웃 복원)$/;
export const DOCK_CLOSE_EDITOR =
  /^(关闭 (编辑器|Editor)|Close (编辑器|Editor)|(편집기|Editor) 닫기)$/;
export const DOCK_CLOSE_TERMINAL =
  /^(关闭 (终端|Terminal|Terminal \d+)|Close (终端|Terminal|Terminal \d+)|(터미널|Terminal|Terminal \d+) 닫기)$/;
export const DOCK_CLOSE_BUTTON = /^(关闭 .+|Close .+|.+ 닫기)$/;
export const DOCK_POPOUT =
  /^(弹出到独立窗口|Pop out to standalone window|독립 창으로 팝아웃)$/;
export const TERMINAL_NEW = /^(新建终端|New Terminal|새 터미널)$/;
export const TERMINAL_INPUT = /^Terminal input$/;
export const TERMINAL_PANEL_TAB = /Terminal \d+/;
export const EDITOR_DISCARD_TITLE =
  /(放弃未保存的修改\?|Discard unsaved changes\?|저장되지 않은 변경 사항을 버리시겠습니까\?)/;
export const EDITOR_DISCARD_CONFIRM =
  /(不保存关闭|Close without saving|저장하지 않고 닫기)/;
export const EDITOR_CANCEL = /(取消|Cancel|취소)/;

export const EDITOR_UNSAVED_CHANGES_SELECTOR = [
  '[aria-label="未保存的更改"]',
  '[aria-label="Unsaved changes"]',
  '[aria-label="저장되지 않은 변경 사항"]',
].join(', ');
