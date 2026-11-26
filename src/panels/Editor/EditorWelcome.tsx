// 无 tab 时的占位(UI polish)。
// 对齐 demo(industrial dark):大圆形 document icon + 标题;下方是 VSCode 空编辑区水印式的「下一步」入口:
//   无工作区 → 打开文件夹 ⌘O / 显示所有命令 ⇧⌘P;有工作区 → 转到文件 ⌘P / 在文件中查找 ⇧⌘F / 新建终端 ⌘T /
//   显示所有命令 ⇧⌘P(VSCode 有工作区的水印同样列 Find in Files / Toggle Terminal)。
// 每项是可聚焦按钮(键盘可达),快捷键标签取实际生效绑定:打开文件夹 / 在文件中查找 / 新建终端走快捷键设置(改键 /
// 解绑 / 冲突落败后跟随),快速打开 / 命令面板是保留键(PICKER_TOGGLE_HOTKEYS,不可改绑)。
// BDD: src/__tests__/editor-welcome/

import { Button, KeyCap } from '@/design';
import { useT } from '@/i18n';
import { formatHotkeyParts, detectPlatform } from '@/plugins/command-palette/format-hotkey';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { PICKER_TOGGLE_HOTKEYS, resolveActiveHotkey } from '@/plugins/picker/use-picker-toggle-hotkey';
import { useCommandPaletteStore } from '@/plugins/command-palette/store';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { coApp } from '@/plugins/co-app';
import { runRegisteredCommand } from '@/lib/run-contributed-action';
import { isHotkeyShadowed } from '@/plugins/command-palette/useCommandHotkeys';
import { useRegistry } from '@/plugins/registries/useRegistry';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { OPEN_FOLDER_COMMAND } from '../Explorer/explorer-commands';

// 有工作区时的另两项:核心插件内联注册的命令(SearchPlugin / TerminalPlugin),按 id 从命令注册表取
const FIND_IN_FILES_COMMAND_ID = 'workbench.action.findInFiles';
const NEW_TERMINAL_COMMAND_ID = 'terminal.new';

const DOCUMENT_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="48"
    height="48"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="text-fg-dim"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
    <path d="M9 13h6" />
    <path d="M9 17h6" />
  </svg>
);

interface WelcomeAction {
  readonly id: string;
  readonly label: string;
  readonly hotkey: string | undefined;
  readonly run: () => void;
}

export function EditorWelcome() {
  const t = useT();
  const hasWorkspace = useWorkspaceStore((s) => s.root !== null);
  const overrides = useKeybindingsStore((s) => s.overrides);
  const platform = detectPlatform();

  // 订阅命令注册表:命令晚于界面注册 / 与之冲突的命令注册注销后,行与快捷键随之更新
  const commands = useRegistry(coApp.commands);
  // 与命令面板 / 全局分发同一来源:有 override 用 override,解绑 / 冲突落败 → 不显示。
  const activeHotkey = (spec: Pick<CommandSpec, 'id' | 'hotkey'>): string | undefined =>
    isHotkeyShadowed(spec.id, commands, platform, overrides) ? undefined : resolveActiveHotkey(spec, overrides, platform);
  /** 经 live 命令注册表执行(与快捷键 / 命令面板同一实现,抛错有 toast)。 */
  const commandAction = (spec: Pick<CommandSpec, 'id' | 'hotkey'>, actionId: string, label: string): WelcomeAction => ({
    id: actionId,
    label,
    hotkey: activeHotkey(spec),
    run: () => void runRegisteredCommand(coApp.commands, spec.id, label),
  });
  /** 已注册的命令才列出(没有就不放一个点了没反应的按钮)。 */
  const registeredAction = (id: string, actionId: string, label: string): WelcomeAction[] => {
    const spec = commands.find((c) => c.id === id);
    return spec ? [commandAction(spec, actionId, label)] : [];
  };

  const showCommands: WelcomeAction = {
    id: 'show-commands',
    label: t('editor.welcome.show_commands'),
    hotkey: PICKER_TOGGLE_HOTKEYS.command_palette,
    run: () => useCommandPaletteStore.getState().open(),
  };
  const actions: readonly WelcomeAction[] = hasWorkspace
    ? [
        {
          id: 'quick-open',
          label: t('editor.welcome.quick_open'),
          hotkey: PICKER_TOGGLE_HOTKEYS.quick_open,
          run: () => useQuickOpenStore.getState().open(),
        },
        ...registeredAction(FIND_IN_FILES_COMMAND_ID, 'find-in-files', t('editor.welcome.find_in_files')),
        ...registeredAction(NEW_TERMINAL_COMMAND_ID, 'new-terminal', t('editor.welcome.new_terminal')),
        showCommands,
      ]
    : [
        commandAction(OPEN_FOLDER_COMMAND, 'open-folder', t('editor.welcome.open_folder')),
        showCommands,
      ];

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center">
      <div
        aria-hidden="true"
        className="flex h-28 w-28 items-center justify-center rounded-full border border-line bg-panel-soft/40"
      >
        {DOCUMENT_ICON}
      </div>
      <div className="text-base font-medium text-fg">{t('editor.welcome.title')}</div>
      <ul aria-label={t('editor.welcome.actions_aria')} className="flex w-full max-w-xs flex-col gap-0.5">
        {actions.map((a) => (
          <li key={a.id}>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-between gap-6"
              onClick={a.run}
              data-welcome-action={a.id}
            >
              <span className="truncate">{a.label}</span>
              {a.hotkey !== undefined && (
                <span className="flex shrink-0 items-center gap-1">
                  {formatHotkeyParts(a.hotkey, platform).map((p, i) => (
                    <KeyCap key={i}>{p}</KeyCap>
                  ))}
                </span>
              )}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
