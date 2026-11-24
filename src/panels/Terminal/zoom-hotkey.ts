// 终端缩放热键:命令注册(TerminalPlugin)与终端「让出该键、不发 \r」判定(useTerminal)同一来源。
// 此前让出判定用兄弟包的 shouldSkipXtermKey(Shift+(Meta|Ctrl)+Enter,不分平台),而命令经 matchesHotkey 按平台
// 匹配(mac 上 mod 只认 Cmd):mac 上 Shift+Ctrl+Enter(Win/Linux 上 Shift+Win+Enter)被拦下不发回车、命令又不匹配,
// 按键被整个吞掉。
import { matchesHotkey } from '@/plugins/command-palette/useCommandHotkeys';
import { detectPlatform, type Platform } from '@/plugins/command-palette/format-hotkey';

export const TERMINAL_ZOOM_HOTKEY = 'shift+mod+enter';

/** 终端应让出给缩放命令的按键(keydown、非输入法组合、按平台匹配缩放热键)。 */
export function isTerminalZoomHotkey(
  event: KeyboardEvent,
  platform: Platform = detectPlatform(),
): boolean {
  return event.type === 'keydown' && !event.isComposing && matchesHotkey(TERMINAL_ZOOM_HOTKEY, event, platform);
}
