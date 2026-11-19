import type { EditorOpenFailureCode } from './types';

/** 宿主 fs 错误码 → editor.openFile 的失败码(SDK 契约只暴露这几类,其余归 EXCEPTION、message 保留)。 */
export function mapFsCodeToEditorCode(code: string): EditorOpenFailureCode {
  switch (code) {
    case 'FS_NOT_FOUND':
    case 'FS_NOT_FILE':
    case 'FS_DENIED':
    case 'FS_IO':
    case 'EXCEPTION':
      return code;
    default:
      return 'EXCEPTION';
  }
}
