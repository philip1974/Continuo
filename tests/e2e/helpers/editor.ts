export const EDITOR_NO_FILE_OPEN =
  /^(未打开文件|No file open|열린 파일 없음)$/;
export const EDITOR_TABS = /^(编辑器标签|Editor tabs|편집기 탭)$/;
export const EDITOR_CLOSE_A_TS = /^(关闭 a\.ts|Close a\.ts|a\.ts 닫기)$/;
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
