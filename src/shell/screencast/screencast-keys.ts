// 屏幕录制模式:一次按键 → 浮层上显示什么(键位 + 命令名)。
// Ported from microsoft/vscode (MIT, © Microsoft Corporation; see LICENSE-3RD-PARTY.md):
// src/vs/workbench/browser/actions/developerActions.ts ToggleScreencastModeAction 的 onKeyDown —— 键位用快捷键的显示格式;按键分发到
// 命令时前面加命令标题(showCommands,默认开;不带分类 = showCommandGroups 默认关);普通字符键同样显示(showKeys 默认开);
// 单独的修饰键、输入法组字中的按键不显示。
// 刻意差异:焦点在密码 / 敏感输入框里(type=password、autocomplete 为密码 / 一次性验证码,或带 data-screencast-sensitive 标记)的
// 按键不显示(VSCode 照常显示,录屏会把输入的密码 / 令牌录进去)。BDD: src/__tests__/screencast-mode/

import { tWithFallback } from '@/i18n';
import { isImeComposing } from '@/design/ime';
import { isInsideMenu } from '@/lib/menu-focus';
import { eventToCombo } from '@/plugins/keybindings/KeybindingCaptureModal';
import { formatHotkey, type Platform } from '@/plugins/command-palette/format-hotkey';
import { isModalOpenFor, winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { PICKER_TOGGLE_COMMAND_IDS, reservedPickerHotkeyOf } from '@/plugins/picker/use-picker-toggle-hotkey';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import type { ScreencastPress } from './screencast-store';

/** 显式标记为敏感的输入区域(其中的按键不进浮层)。 */
export const SCREENCAST_SENSITIVE_ATTR = 'data-screencast-sensitive';

const SENSITIVE_AUTOCOMPLETE = new Set(['current-password', 'new-password', 'one-time-code']);

/** 按键目标是否敏感输入(跨窗口:不用 instanceof,popout 子窗的元素属于另一个 realm)。 */
export function isSensitiveKeyTarget(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.closest(`[${SCREENCAST_SENSITIVE_ATTR}]`)) return true;
  if (el.tagName !== 'INPUT') return false;
  if ((el.getAttribute('type') ?? '').toLowerCase() === 'password') return true;
  const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
  return autocomplete.some((token) => SENSITIVE_AUTOCOMPLETE.has(token));
}

/** 先清空再追加的按键(VSCode:带修饰键、Backspace、Esc、方向键)。 */
function restartsOverlay(e: KeyboardEvent): boolean {
  return (
    e.ctrlKey ||
    e.altKey ||
    e.metaKey ||
    e.shiftKey ||
    e.key === 'Backspace' ||
    e.key === 'Escape' ||
    e.key.startsWith('Arrow')
  );
}

export interface ScreencastCommands {
  readonly all: readonly CommandSpec[];
  readonly get: (id: string) => CommandSpec | undefined;
}

/** 按键分发到的命令:⌘P / ⇧⌘P 是 picker 保留键(转到文件… / 显示所有命令);其余按分发表裁决(对话框 / 菜单里不分发 → 无)。 */
function commandFor(
  e: KeyboardEvent,
  combo: string,
  commands: ScreencastCommands,
  platform: Platform,
  overrides: Readonly<Record<string, string>>,
): CommandSpec | undefined {
  const reserved = reservedPickerHotkeyOf(combo, platform);
  if (reserved) return commands.get(PICKER_TOGGLE_COMMAND_IDS[reserved]);
  if (isModalOpenFor(e) || isInsideMenu(e.target)) return undefined;
  return winningCommandFor(e, commands.all, platform, overrides);
}

/** 一次 keydown 在浮层上的条目;不显示(单独修饰键 / 组字中 / 敏感输入)→ null。 */
export function describeScreencastKey(
  e: KeyboardEvent,
  commands: ScreencastCommands,
  platform: Platform,
  overrides: Readonly<Record<string, string>>,
): { readonly press: Omit<ScreencastPress, 'id'>; readonly restart: boolean } | null {
  if (isImeComposing(e) || isSensitiveKeyTarget(e.target)) return null;
  const combo = eventToCombo(e, platform);
  if (combo === null) return null;
  const keys = formatHotkey(combo, platform);
  if (keys.length === 0) return null;
  const cmd = commandFor(e, combo, commands, platform, overrides);
  const title = cmd ? tWithFallback(cmd.titleKey, cmd.title) : undefined;
  return { press: title ? { keys, title } : { keys }, restart: restartsOverlay(e) };
}
