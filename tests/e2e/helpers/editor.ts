export const EDITOR_NO_FILE_OPEN =
  /^(未打开文件|No file open|열린 파일 없음)$/;

export const EDITOR_UNSAVED_CHANGES_SELECTOR = [
  '[aria-label="未保存的更改"]',
  '[aria-label="Unsaved changes"]',
  '[aria-label="저장되지 않은 변경 사항"]',
].join(', ');
