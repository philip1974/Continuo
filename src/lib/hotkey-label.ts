// 界面上的快捷键提示(对齐 VSCode:tooltip「名称 (⌘B)」、菜单项右侧显示键位)。命令键取**当前生效绑定**
//(resolveDisplayHotkey:用户改绑跟随、解绑 / 落在 ⌘P·⌘⇧P 保留键 / 与别的命令冲突落败 → 不显示;转到文件… / 显示所有命令显示其保留键),按平台格式化(formatHotkey:mac ⌘⇧⌥,
// 其它 Ctrl+Shift+Alt)。BDD: src/__tests__/hotkey-hints/

import { detectPlatform, formatHotkey, type Platform } from '@/plugins/command-palette/format-hotkey';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { resolveDisplayHotkey } from '@/plugins/picker/use-picker-toggle-hotkey';
import { isHotkeyShadowed } from '@/plugins/command-palette/useCommandHotkeys';
import { coApp } from '@/plugins/co-app';
import { useRegistry, type RegistryLike } from '@/plugins/registries/useRegistry';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';

type HotkeySpec = Pick<CommandSpec, 'id' | 'hotkey'>;

/** tooltip 文案:有键位 →「名称 (键位)」,否则只有名称。 */
export function withHotkey(label: string, hotkey: string | undefined): string {
  return hotkey ? `${label} (${hotkey})` : label;
}

/** 固定键位(不经快捷键设置,如资源管理器树内 ⌘C / F2、查找选项 ⌥⌘C)的显示文案。 */
export function hotkeyText(combo: string, platform: Platform = detectPlatform()): string {
  return formatHotkey(combo, platform);
}

/** 命令当前生效键位的显示文案;命令缺失 / 未绑定 / 冲突落败(按下执行别的命令)→ undefined。 */
export function commandHotkeyText(
  spec: HotkeySpec | undefined,
  overrides: Readonly<Record<string, string>> = useKeybindingsStore.getState().overrides,
  platform: Platform = detectPlatform(),
  commands: readonly CommandSpec[] = coApp.commands.getAll(),
): string | undefined {
  if (!spec || isHotkeyShadowed(spec.id, commands, platform, overrides)) return undefined;
  const combo = resolveDisplayHotkey(spec, overrides, platform);
  return combo ? formatHotkey(combo, platform) : undefined;
}

/** React 版:订阅快捷键 override,改键后重渲。commands:冲突判定用的命令表(缺省全局命令注册表)。 */
export function useCommandHotkeyText(
  spec: HotkeySpec | undefined,
  commands?: readonly CommandSpec[],
): string | undefined {
  const overrides = useKeybindingsStore((s) => s.overrides);
  return commandHotkeyText(spec, overrides, undefined, commands);
}

/** 按命令 id 从命令注册表取默认键(核心插件内联注册的命令);同时订阅注册表,命令晚于界面注册也会补上。 */
export function useRegisteredCommandHotkeyText(
  registry: RegistryLike<CommandSpec> & { get(id: string): CommandSpec | undefined },
  id: string,
): string | undefined {
  const commands = useRegistry(registry); // 订阅:命令注册 / 注销(含与之冲突的插件命令)后重算
  return useCommandHotkeyText(registry.get(id), commands);
}
