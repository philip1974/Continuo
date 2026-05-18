import type { TranslationKey } from './en';

export const zh: Record<TranslationKey, string> = {
  // common
  'common.cancel': '取消',
  'common.save': '保存',
  'common.delete': '删除',
  'common.ok': '确定',
  'common.close': '关闭',
  'common.loading': '加载中…',
  'common.retry': '重试',
  'common.select': '选择',
  'common.enable': '启用',
  'common.disable': '禁用',

  // menu.file
  'menu.file.label': '文件',
  'menu.file.new_window': '新建窗口',
  'menu.file.open_folder_in_new_window': '在新窗口中打开文件夹…',
  'menu.file.close': '关闭',

  // settings.general
  'settings.general.tab_title': '通用',
  'settings.general.title': '通用',
  'settings.general.theme.title': '主题',
  'settings.general.theme.description': '选择 Continuo 的视觉主题。system 跟随操作系统。',
  'settings.general.theme.light': '亮色',
  'settings.general.theme.dark': '暗色',
  'settings.general.theme.system': '跟随系统',
  'settings.general.language.title': '语言',
  'settings.general.language.description': '选择 Continuo 的界面语言。立即生效。',
  'settings.experimental.onlyEn': '实验性',

  // errors.MAIN_*
  'errors.AGENT_NOT_AUTHORIZED': 'Agent 未授权',
  'errors.BAD_INPUT': '输入无效',
  'errors.BAD_MAIN': '插件主文件错误',
  'errors.BAD_MANIFEST': '插件清单错误',
  'errors.BAD_ROOT': '工作区根目录错误',
  'errors.BAD_URL': 'URL 无效',
  'errors.BUFFER_SESSION_NOT_FOUND': 'Buffer 会话不存在',
  'errors.EEXIST': '文件已存在',
  'errors.GIT_FAILED': 'Git 命令失败',
  'errors.GIT_SPAWN_FAILED': '无法启动 git',
  'errors.INVALID_ID': 'ID 无效',
  'errors.MCP_HOST_BIND_FORBIDDEN': 'MCP 主机绑定被拒',
  'errors.NO_WINDOW': '找不到窗口',
  'errors.NO_WINDOW_SEQ': '找不到窗口序号',
  'errors.NOT_INSTALLED': '未安装',
  'errors.PAYLOAD_TOO_LARGE': '负载过大',
  'errors.POPOUT_NOT_IMPLEMENTED': 'Popout 未实现',
  'errors.RM_FAILED': '删除失败',
  'errors.TERMINAL_CWD_UNRESOLVED': '终端 cwd 无法解析',
  'errors.TERMINAL_FORBIDDEN_SHELL': '禁用的 shell',
  'errors.TERMINAL_NO_WINDOW': '终端：找不到窗口',
  'errors.TERMINAL_NOT_FOUND': '找不到终端',
  'errors.TERMINAL_SESSION_DUPLICATE': '终端会话重复',
  'errors.TERMINAL_SESSION_NOT_FOUND': '终端会话不存在',
  'errors.WORKSPACE_NOT_ABSOLUTE': '工作区路径必须是绝对路径：{path}',
  'errors.WORKSPACE_NOT_DIRECTORY': '工作区不是一个目录：{workspace}',
  'errors.WORKSPACE_NOT_FOUND': '找不到工作区：{workspace}',

  // errors.FS_*
  'errors.FS_BAD_NAME': '文件名不合法',
  'errors.FS_DENIED': '拒绝访问',
  'errors.FS_EEXIST': '已存在',
  'errors.FS_IO': '文件 I/O 错误',
  'errors.FS_NOT_DIRECTORY': '不是目录',
  'errors.FS_NOT_FILE': '不是文件',
  'errors.FS_NOT_FOUND': '找不到文件：{path}',

  // ── topic-19 i18n-strings-r2 ──────────────────────────────────────

  // commands.*
  'commands.terminal.new.title': '新建终端',
  'commands.terminal.category': '终端',
  'commands.window.new.title': '新建窗口',
  'commands.window.open_folder.title': '在新窗口中打开文件夹…',
  'commands.window.category': '窗口',
  'commands.settings.toggle.title': '切换 Settings',
  'commands.settings.category': '设置',

  // panels.*
  'panels.terminal.title': '终端',
  'panels.editor.title': '编辑器',
  'panels.output.title': '输出',
  'panels.settings.title': '设置',
  'panels.language.title': '语言',

  // settings tabs / items
  'settings.terminal.tab_title': '终端',
  'settings.terminal.font_size': '字号',
  'settings.terminal.cursor_style': '光标样式',
  'settings.keybindings.tab_title': '快捷键',
  'settings.editor.tab_title': '编辑器',
  'settings.editor.font_size': '字号',
  'settings.editor.show_line_numbers': '显示行号',
  'settings.editor.auto_save_markdown': '自动保存 Markdown',
  'settings.editor.auto_save_delay': '自动保存延迟',
  'settings.plugins.tab_title': '插件',
  'settings.plugins.market_title': '插件商店',
  'settings.explorer.tab_title': '资源管理器',
  'settings.explorer.toggle_sidebar': '切换 Explorer 侧栏',
  'settings.explorer.show_hidden_files': '显示隐藏文件',
  'settings.explorer.indent_width': '缩进宽度',

  // panels.explorer.*
  'panels.explorer.btn.new_file': '新建文件',
  'panels.explorer.btn.new_folder': '新建文件夹',
  'panels.explorer.btn.refresh': '刷新资源管理器',
  'panels.explorer.btn.collapse_all': '折叠全部',
  'panels.explorer.btn.more_actions': '更多操作',
  'panels.explorer.placeholder.new_folder': '新建文件夹名…',
  'panels.explorer.placeholder.new_file': '新建文件名…',
  'panels.explorer.confirm.confirm': '确认',
  'panels.explorer.confirm.cancel': '取消',
  'panels.explorer.confirm.cancel_esc': '取消 (Esc)',
  'panels.explorer.empty.open_folder': '打开文件夹',
  'panels.explorer.empty.opening': '打开中…',
  'panels.explorer.empty.no_folder': '未打开文件夹',
  'panels.explorer.empty.recent': '最近打开',
  'panels.explorer.drop.upload_to': '放下以上传到 {target}',
  'panels.explorer.menu.expand_all': '展开全部',
  'panels.explorer.menu.open_recent': '打开最近',
  'panels.explorer.menu.switch_folder': '切换文件夹…',
  'panels.explorer.menu.close_folder': '关闭文件夹',
  'panels.explorer.create.in_label': '在: {dir}',

  // panels.terminal.*
  'panels.terminal.aria.start_shell': '启动 shell',
  'panels.terminal.aria.new_terminal': '新建终端',
  'panels.terminal.aria.close_terminal': '关闭终端 {name}',
  'panels.terminal.no_active': '无活跃终端',

  // panels.editor.*
  'panels.editor.untitled': '未命名',
  'panels.editor.draft': '草稿',
  'panels.editor.unsaved_draft': '未保存草稿',
  'panels.editor.placeholder.start_writing': '开始书写…',
  'panels.editor.discard_title': '放弃未保存的修改?',
  'panels.editor.discard_body': '有未保存的修改。继续将永久丢失改动。',
  'panels.editor.discard_confirm': '不保存关闭',

  // permissions.*
  'permissions.agent.terminal_create_session': '新建一个 terminal',
  'permissions.agent.generic': '调用 {method}',
  'permissions.agent.title': 'Agent 请求控制内置终端',
  'permissions.agent.body_prefix': '外部 agent',
  'permissions.agent.body_via_mcp': '通过 MCP 请求',
  'permissions.agent.body_suffix': '。',
  'permissions.agent.hint': '授权后，持有 MCP token 的 agent 可以创建 / 关闭 / 写入 / 读取 terminal。token 仅本次启动有效，Continuo 退出即作废。',
  'permissions.agent.deny': '拒绝',
  'permissions.agent.grant_once': '仅本次',
  'permissions.agent.grant_session': '本次启动期间允许',
  'permissions.revoke_all.confirm':
    '将终止 {count} 个 agent terminal 并撤销本次启动期间的授权。\n\n已运行的 agent CLI 持有的 token 将立刻 401；新开 terminal 仍可重新授权。\n\n确定继续？',

  // statusbar.*
  'statusbar.mcp.copy': '复制 MCP 配置',
  'statusbar.mcp.copied': '已复制',
  'statusbar.mcp.copy_failed': '复制失败',
  'statusbar.mcp.unavailable': 'MCP 不可用',
  'statusbar.mcp.tooltip':
    "复制 'claude mcp add' 命令到剪贴板，可在任意 shell 跑配置 Claude Code（stdio transport，一次配置永久）",
  'statusbar.mcp.revoke_tooltip': '终止全部 {count} 个 agent terminal 并撤销授权',
  'statusbar.no_workspace': '无工作区',
  'statusbar.sidebar_hidden': '侧栏已隐藏',
  'statusbar.untitled_file': '未命名',
  'statusbar.git_branch_placeholder': 'git 分支（占位）',
  'statusbar.editor_stats': '{lines} 行 · {words} 词 · {chars} 字符',

  // errors.* topic-19
  'errors.terminal.cwd_unresolved': '请先打开 workspace',
  'errors.terminal.create_failed': '无法新建终端：{code}',
  'errors.folder.move_failed': '移动失败：{src}: {message}',
  'errors.folder.paste_failed': '粘贴失败：{src}: {message}',
  'errors.folder.trash_failed': '移到废纸篓失败：{path}: {message}',
  'errors.folder.skipped_dirs': '跳过 {count} 个文件夹（暂不支持目录拖入）',
  'errors.folder.batch_failed': '失败 {count} 个：',

  // command_palette.*
  'command_palette.placeholder': '输入命令名…',
  'command_palette.list_aria': '命令列表',
  'command_palette.empty': '暂无可用命令',
  'command_palette.no_match': '无匹配命令',

  // keybindings.*
  'keybindings.default_group': '其他',
  'keybindings.search_placeholder': '搜索命令名 / 分类 / 快捷键…',
  'keybindings.total_summary_prefix': '共 {count} 个有快捷键的命令 · 无 hotkey 请用',
  'keybindings.total_summary_suffix': '命令面板搜索',
  'keybindings.empty': '暂无注册了快捷键的命令',
  'keybindings.no_match': '无匹配命令',
  'keybindings.unbound': '未绑定',
  'keybindings.edit_hotkey': '编辑快捷键',
  'keybindings.reset_default': '恢复默认（{hotkey}）',
  'keybindings.reset_default_aria': '恢复默认',

  // shell aria/labels
  'shell.aria.drag_resize': '拖拽改变宽度',
  'shell.iconbar.hide_explorer': '隐藏 Explorer',
  'shell.iconbar.show_explorer': '显示 Explorer',
  'shell.iconbar.settings': '设置',
  'shell.dock.popout_aria': '弹出当前面板',
  'shell.dock.popout_title': '弹出到独立窗口',
};
