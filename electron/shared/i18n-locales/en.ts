// MVP key catalog — en (type source).
// 新增 key 必须在三个 locale 文件同步；zh/ko 用 satisfies Record<keyof typeof en, string> 强约束。
//
// 命名规范:
//   common.<verb>           通用动词/状态文案
//   menu.<top>.<item>       Electron Menu 标签
//   settings.<category>.<x> 设置项标题/描述
//   errors.<CODE>           ERROR_CODES enum 对应的本地化 message

export const en = {
  // common (10)
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.delete': 'Delete',
  'common.ok': 'OK',
  'common.close': 'Close',
  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'common.select': 'Select',
  'common.enable': 'Enable',
  'common.disable': 'Disable',

  // menu.file (4)
  'menu.file.label': 'File',
  'menu.file.new_window': 'New Window',
  'menu.file.open_folder_in_new_window': 'Open Folder in New Window…',
  'menu.file.close': 'Close',

  // settings.general (10)
  'settings.general.tab_title': 'General',
  'settings.general.title': 'General',
  'settings.general.theme.title': 'Theme',
  'settings.general.theme.description': "Choose Continuo's visual theme. system follows the OS.",
  'settings.general.theme.light': 'Light',
  'settings.general.theme.dark': 'Dark',
  'settings.general.theme.system': 'System',
  'settings.general.language.title': 'Language',
  'settings.general.language.description': "Choose Continuo's UI language. Changes take effect immediately.",
  'settings.experimental.onlyEn': 'Experimental',

  // errors.MAIN_* (27)
  'errors.AGENT_NOT_AUTHORIZED': 'Agent not authorized',
  'errors.BAD_INPUT': 'Bad input',
  'errors.BAD_MAIN': 'Bad plugin main file',
  'errors.BAD_MANIFEST': 'Bad plugin manifest',
  'errors.BAD_ROOT': 'Bad workspace root',
  'errors.BAD_URL': 'Bad URL',
  'errors.BUFFER_SESSION_NOT_FOUND': 'Buffer session not found',
  'errors.EEXIST': 'File already exists',
  'errors.GIT_FAILED': 'Git command failed',
  'errors.GIT_SPAWN_FAILED': 'Failed to start git',
  'errors.INVALID_ID': 'Invalid id',
  'errors.MCP_HOST_BIND_FORBIDDEN': 'MCP host bind forbidden',
  'errors.NO_WINDOW': 'No window',
  'errors.NO_WINDOW_SEQ': 'No window sequence',
  'errors.NOT_INSTALLED': 'Not installed',
  'errors.PAYLOAD_TOO_LARGE': 'Payload too large',
  'errors.POPOUT_NOT_IMPLEMENTED': 'Popout not implemented',
  'errors.RM_FAILED': 'Remove failed',
  'errors.TERMINAL_CWD_UNRESOLVED': 'Terminal cwd unresolved',
  'errors.TERMINAL_FORBIDDEN_SHELL': 'Forbidden shell',
  'errors.TERMINAL_NO_WINDOW': 'Terminal: no window',
  'errors.TERMINAL_NOT_FOUND': 'Terminal not found',
  'errors.TERMINAL_SESSION_DUPLICATE': 'Terminal session duplicate',
  'errors.TERMINAL_SESSION_NOT_FOUND': 'Terminal session not found',
  'errors.WORKSPACE_NOT_ABSOLUTE': 'Workspace must be an absolute path: {path}',
  'errors.WORKSPACE_NOT_DIRECTORY': 'Workspace is not a directory: {workspace}',
  'errors.WORKSPACE_NOT_FOUND': 'Workspace not found: {workspace}',

  // errors.FS_* (7)
  'errors.FS_BAD_NAME': 'Invalid file name',
  'errors.FS_DENIED': 'Access denied',
  'errors.FS_EEXIST': 'Already exists',
  'errors.FS_IO': 'File I/O error',
  'errors.FS_NOT_DIRECTORY': 'Not a directory',
  'errors.FS_NOT_FILE': 'Not a file',
  'errors.FS_NOT_FOUND': 'File not found: {path}',
} as const;

export type TranslationKey = keyof typeof en;
