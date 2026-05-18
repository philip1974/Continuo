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

  // ── topic-19 i18n-strings-r2 ──────────────────────────────────────

  // commands.* (7)
  'commands.terminal.new.title': 'New Terminal',
  'commands.terminal.category': 'Terminal',
  'commands.window.new.title': 'New Window',
  'commands.window.open_folder.title': 'Open Folder in New Window…',
  'commands.window.category': 'Window',
  'commands.settings.toggle.title': 'Toggle Settings',
  'commands.settings.category': 'Settings',

  // panels.* (5)
  'panels.terminal.title': 'Terminal',
  'panels.editor.title': 'Editor',
  'panels.output.title': 'Output',
  'panels.settings.title': 'Settings',
  'panels.language.title': 'Language',

  // settings tabs / items (15)
  'settings.terminal.tab_title': 'Terminal',
  'settings.terminal.font_size': 'Font size',
  'settings.terminal.cursor_style': 'Cursor style',
  'settings.keybindings.tab_title': 'Keybindings',
  'settings.editor.tab_title': 'Editor',
  'settings.editor.font_size': 'Font size',
  'settings.editor.show_line_numbers': 'Show line numbers',
  'settings.editor.auto_save_markdown': 'Auto-save Markdown',
  'settings.editor.auto_save_delay': 'Auto-save delay',
  'settings.plugins.tab_title': 'Plugins',
  'settings.plugins.market_title': 'Plugin Market',
  'settings.explorer.tab_title': 'Explorer',
  'settings.explorer.toggle_sidebar': 'Toggle Explorer sidebar',
  'settings.explorer.show_hidden_files': 'Show hidden files',
  'settings.explorer.indent_width': 'Indent width',

  // panels.explorer.* (11)
  'panels.explorer.btn.new_file': 'New file',
  'panels.explorer.btn.new_folder': 'New folder',
  'panels.explorer.btn.refresh': 'Refresh',
  'panels.explorer.btn.collapse_all': 'Collapse all',
  'panels.explorer.btn.more_actions': 'More actions',
  'panels.explorer.placeholder.new_folder': 'New folder name…',
  'panels.explorer.placeholder.new_file': 'New file name…',
  'panels.explorer.confirm.confirm': 'Confirm',
  'panels.explorer.confirm.cancel': 'Cancel',
  'panels.explorer.confirm.cancel_esc': 'Cancel (Esc)',
  'panels.explorer.empty.open_folder': 'Open Folder',
  'panels.explorer.empty.opening': 'Opening…',
  'panels.explorer.empty.no_folder': 'No folder open',
  'panels.explorer.empty.recent': 'Recent',
  'panels.explorer.drop.upload_to': 'Drop to upload to {target}',
  'panels.explorer.menu.expand_all': 'Expand all',
  'panels.explorer.menu.open_recent': 'Open recent',
  'panels.explorer.menu.switch_folder': 'Switch folder…',
  'panels.explorer.menu.close_folder': 'Close folder',
  'panels.explorer.create.in_label': 'in: {dir}',

  // panels.terminal.* aria + dynamic (4)
  'panels.terminal.aria.start_shell': 'Starting shell',
  'panels.terminal.aria.new_terminal': 'New terminal',
  'panels.terminal.aria.close_terminal': 'Close terminal {name}',
  'panels.terminal.no_active': 'No active terminal',

  // panels.editor.* (4)
  'panels.editor.untitled': 'Untitled',
  'panels.editor.draft': 'Draft',
  'panels.editor.unsaved_draft': 'Unsaved draft',
  'panels.editor.placeholder.start_writing': 'Start writing…',
  'panels.editor.discard_title': 'Discard unsaved changes?',
  'panels.editor.discard_body': 'has unsaved changes. Continuing will permanently discard them.',
  'panels.editor.discard_confirm': 'Close without saving',

  // permissions.* (3)
  'permissions.agent.terminal_create_session': 'open a new terminal',
  'permissions.agent.generic': 'call {method}',
  'permissions.agent.title': 'Agent requests built-in terminal access',
  'permissions.agent.body_prefix': 'External agent',
  'permissions.agent.body_via_mcp': 'requests via MCP to',
  'permissions.agent.body_suffix': '.',
  'permissions.agent.hint': 'Once granted, agents holding the MCP token can create / close / write / read terminals. The token is valid only for this launch and is invalidated when Continuo exits.',
  'permissions.agent.deny': 'Deny',
  'permissions.agent.grant_once': 'Just this time',
  'permissions.agent.grant_session': 'Allow this launch',
  'permissions.revoke_all.confirm':
    'Will terminate {count} agent terminal(s) and revoke authorization granted during this launch.\n\nRunning agent CLIs holding tokens will 401 immediately; new terminals can re-authorize.\n\nContinue?',

  // statusbar.* (8)
  'statusbar.mcp.copy': 'Copy MCP config',
  'statusbar.mcp.copied': 'Copied',
  'statusbar.mcp.copy_failed': 'Copy failed',
  'statusbar.mcp.unavailable': 'MCP unavailable',
  'statusbar.mcp.tooltip':
    "Copy 'claude mcp add' command to clipboard. Run it in any shell to configure Claude Code (stdio transport, one-time setup).",
  'statusbar.mcp.revoke_tooltip': 'Terminate all {count} agent terminal(s) and revoke authorization',
  'statusbar.no_workspace': 'No workspace',
  'statusbar.sidebar_hidden': 'Sidebar hidden',
  'statusbar.untitled_file': 'Untitled',
  'statusbar.git_branch_placeholder': 'git branch (placeholder)',
  'statusbar.editor_stats': '{lines} lines · {words} words · {chars} chars',

  // errors.* topic-19 (4)
  'errors.terminal.cwd_unresolved': 'Please open a workspace first',
  'errors.terminal.create_failed': 'Failed to create terminal: {code}',
  'errors.folder.move_failed': 'Move failed: {src}: {message}',
  'errors.folder.paste_failed': 'Paste failed: {src}: {message}',
  'errors.folder.trash_failed': 'Move to trash failed: {path}: {message}',
  'errors.folder.skipped_dirs': 'Skipped {count} folder(s) (directories not supported)',
  'errors.folder.batch_failed': '{count} failed:',

  // settings.panel.* + settings.item.* (topic-20)
  'settings.panel.search_placeholder': 'Search settings (title / description / id)…',
  'settings.panel.nav_aria': 'Setting categories',
  'settings.panel.no_items': 'No settings available',
  'settings.panel.no_match': 'No settings matched "{q}"',
  'settings.panel.matched': 'Matched {count} for "{q}"',
  'settings.item.reset_default': 'Reset to default ({default})',
  'settings.item.reset_default_aria': 'Reset to default',

  // plugins_tab.* (topic-20)
  'plugins_tab.label.panels': 'Panel types',
  'plugins_tab.label.commands': 'Commands',
  'plugins_tab.label.statusbar': 'StatusBar items',
  'plugins_tab.label.ribbon': 'Ribbon icons',
  'plugins_tab.label.setting_tabs': 'Setting Tabs',
  'plugins_tab.label.explorer_decorators': 'Explorer decorators',
  'plugins_tab.label.editor_actions': 'Editor Actions',
  'plugins_tab.section.contributions': 'Registered contribution points',
  'plugins_tab.section.builtin': 'Built-in plugins',
  'plugins_tab.section.user': 'User plugins',
  'plugins_tab.section.install_from_git': 'Install from Git URL',
  'plugins_tab.section.install_warning': 'You can install directly via a Git URL. Note that third-party repositories may have security risks; only trust the source code and its author.',
  'plugins_tab.install.placeholder': 'Git URL (HTTPS or SSH)',
  'plugins_tab.install.pending': 'Pending plugin: {name} v{version} — reload LM to activate',
  'plugins_tab.user.no_plugins': 'No user plugins installed',
  'plugins_tab.user.status_active': 'active',
  'plugins_tab.user.status_disabled': 'disabled',
  'plugins_tab.user.status_failed': 'failed',
  'plugins_tab.user.status_unknown': 'unknown',
  'plugins_tab.error.generic': '✘ {message}',
  'plugins_tab.user.pending_hint': '⏳ Installed, reload LM to see it in the list and enable',
  'plugins_tab.btn.reload': 'Reload',
  'plugins_tab.btn.disable': 'Disable',
  'plugins_tab.btn.enable': 'Enable',
  'plugins_tab.btn.permissions': 'Permissions',
  'plugins_tab.btn.uninstall': 'Uninstall',
  'plugins_tab.core.editor_desc': 'Built-in editor panel (markdown / code)',
  'plugins_tab.core.terminal_desc': 'Built-in terminal panel (node-pty)',
  'plugins_tab.core.output_desc': 'Built-in output log panel',
  'plugins_tab.core.plugins_name': 'Plugin management',
  'plugins_tab.core.plugins_desc': 'This tab itself — plugin system self-check view',
  'plugins_tab.install.installing': 'Installing…',
  'plugins_tab.install.install': 'Install',
  'plugins_tab.install.success': '✔ Installed {name} v{version} — reload LM to load the plugin',
  'plugins_tab.install.uninstall_fail': '✘ Uninstall failed: {message}',
  'plugins_tab.action.reload_tooltip': 'Reload this plugin (fetch latest code)',
  'plugins_tab.action.retry_enable_tooltip': 'Retry enable (permission denials will re-prompt)',
  'plugins_tab.action.edit_permissions_tooltip': 'Edit this plugin permissions',
  'plugins_tab.action.uninstall_tooltip': 'Uninstall this plugin (remove disk directory)',
  'plugins_tab.uninstall.title': 'Uninstall plugin?',
  'plugins_tab.uninstall.body': 'Will permanently delete {id} installation directory and all its data. The operation is irreversible; reinstall from git URL to recover.',
  'plugins_tab.uninstall.confirm': 'Uninstall',

  // command_palette.* (4)
  'command_palette.placeholder': 'Type a command…',
  'command_palette.list_aria': 'Command list',
  'command_palette.empty': 'No commands available',
  'command_palette.no_match': 'No matching command',

  // keybindings.* tab content (10)
  'keybindings.default_group': 'Other',
  'keybindings.search_placeholder': 'Search commands / categories / hotkeys…',
  'keybindings.total_summary_prefix': '{count} commands with hotkey · for unbound use',
  'keybindings.total_summary_suffix': 'command palette to search',
  'keybindings.empty': 'No commands have hotkeys',
  'keybindings.no_match': 'No matching command',
  'keybindings.unbound': 'Unbound',
  'keybindings.edit_hotkey': 'Edit hotkey',
  'keybindings.reset_default': 'Reset to default ({hotkey})',
  'keybindings.reset_default_aria': 'Reset to default',

  // shell aria/labels (6)
  'shell.aria.drag_resize': 'Drag to resize',
  'shell.iconbar.hide_explorer': 'Hide Explorer',
  'shell.iconbar.show_explorer': 'Show Explorer',
  'shell.iconbar.settings': 'Settings',
  'shell.dock.popout_aria': 'Pop out active panel',
  'shell.dock.popout_title': 'Pop out to standalone window',
} as const;

export type TranslationKey = keyof typeof en;
