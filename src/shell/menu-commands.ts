// 应用菜单项即 renderer 命令(MENU_COMMAND_IDS,如 文件 → 打开文件夹… ⌘O):main 发 RUN_MENU_COMMAND,这里经命令注册表执行;
// 反向把菜单命令当前生效的主键推给 main(菜单 accelerator 跟随改键 / 解绑 / 冲突落败)。
// BDD: src/__tests__/explorer-commands/(第 5 条)、src/__tests__/app-menu-bar/

import { useEffect, useMemo } from 'react';
import { coApi } from '@/lib/co-api';
import { tWithFallback } from '@/i18n';
import { hasOpenModalIn } from '@/design/Modal';
import { isInsideMenu } from '@/lib/menu-focus';
import { whenHoldsInDocument } from '@/lib/editor-text-focus';
import { runRegisteredCommand } from '@/lib/run-contributed-action';
import type { CommandRegistry, CommandSpec } from '@/plugins/registries/CommandRegistry';
import { useRegistry } from '@/plugins/registries/useRegistry';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { resolveDisplayHotkey } from '@/plugins/picker/use-picker-toggle-hotkey';
import { isHotkeyShadowed } from '@/plugins/command-palette/useCommandHotkeys';
import { canonicalHotkey, detectPlatform, type Platform } from '@/plugins/command-palette/format-hotkey';
import { getPopoutDocuments, runInCommandDocument } from '@/shell/dock/popout-documents';
import { useSettingValue } from '@/plugins/settings/values-store';
import { FILES_AUTO_SAVE, type FilesAutoSaveMode } from '@/plugins/settings/core-setting-specs';
import {
  isMenuCommandPayload,
  MENU_COMMAND_IDS,
  type MenuCheckboxId,
  type MenuCommandId,
} from '../../electron/shared/window-channels';

/** 菜单触发的命令作用于哪个窗口的文档:获焦的 popout 子窗(只有一个子窗时即它),否则主窗。 */
function menuCommandDocument(fromPopout: boolean): Document {
  if (!fromPopout) return document;
  const popouts = getPopoutDocuments();
  return popouts.find((doc) => doc.hasFocus()) ?? (popouts.length === 1 ? popouts[0]! : document);
}

/**
 * 只认登记过的菜单命令;任一文档(主窗 / popout 子窗)有 Modal 打开、或焦点在打开的菜单里时不执行(与工作台快捷键一致,
 * 对齐 VSCode)。命令作用于获焦的窗口(与热键分发同一机制 runInCommandDocument:popout 子窗获焦 → 该子窗)。
 * accelerator 触发(viaKey:按键已先经 renderer 分发而未被处理)→ 按命令的上下文条件重新判定,不成立不执行(终端里按 ⌘/
 * 不去注释编辑器);点击菜单项不受上下文条件限制,与命令面板一致(编辑器命令作用于该窗口的活动文本编辑器,没有则静默)。
 * 选择器类命令(转到文件 / 转到行 / 命令面板 / 打开最近)画在该窗口;在主窗打开面板的命令(⌘, / ⇧⌘F…)从子窗触发时激活主窗
 *(BDD: src/__tests__/popout-picker/)。
 */
export function runMenuCommand(commands: CommandRegistry, payload: unknown): void {
  if (!isMenuCommandPayload(payload)) return;
  const blocked = (doc: Document) => hasOpenModalIn(doc) || isInsideMenu(doc.activeElement);
  if (blocked(document) || getPopoutDocuments().some(blocked)) return;
  const spec = commands.get(payload.id);
  const doc = menuCommandDocument(payload.fromPopout);
  if (payload.viaKey && !whenHoldsInDocument(spec?.when, doc)) return;
  const label = spec ? tWithFallback(spec.titleKey, spec.title) : payload.id;
  void runInCommandDocument(doc, () => runRegisteredCommand(commands, payload.id, label));
}

/**
 * 菜单命令当前显示的主键(归一后的 hotkey,见 canonicalHotkey):与命令面板 / tooltip 同一规则(resolveDisplayHotkey:改键跟随、
 * 解绑 / 落在保留键上不显示,转到文件… / 显示所有命令显示其保留键),冲突落败(按下执行别的命令)不显示。未注册 → null。
 */
export function menuKeybindings(
  commands: Pick<CommandRegistry, 'get'>,
  all: readonly CommandSpec[],
  overrides: Readonly<Record<string, string>>,
  platform: Platform,
): Record<MenuCommandId, string | null> {
  const out = {} as Record<MenuCommandId, string | null>;
  for (const id of MENU_COMMAND_IDS) {
    const spec = commands.get(id);
    const combo = spec && !isHotkeyShadowed(id, all, platform, overrides) ? resolveDisplayHotkey(spec, overrides, platform) : undefined;
    out[id] = combo ? canonicalHotkey(combo, platform) : null;
  }
  return out;
}

/** 勾选类菜单项的勾选状态:文件 → 自动保存 = files.autoSave ≠ off(VSCode toggled: config.files.autoSave != off)。 */
export function menuCheckedState(autoSave: FilesAutoSaveMode): Record<MenuCheckboxId, boolean> {
  return { 'workbench.action.toggleAutoSave': autoSave !== 'off' };
}

export function useMenuCommands(commands: CommandRegistry): void {
  useEffect(() => coApi.window.onMenuCommand((payload) => runMenuCommand(commands, payload)), [commands]);

  // 命令注册 / 注销、改键 / 解绑后重算;内容不变不重复推送。
  const all = useRegistry(commands);
  const overrides = useKeybindingsStore((s) => s.overrides);
  const platform = useMemo(() => detectPlatform(), []);
  const serialized = useMemo(
    () => JSON.stringify(menuKeybindings(commands, all, overrides, platform)),
    [commands, all, overrides, platform],
  );
  useEffect(() => {
    const keybindings = JSON.parse(serialized) as Record<MenuCommandId, string | null>;
    // 推送失败只影响菜单上的键位显示,不打扰用户
    coApi.window.setMenuKeybindings(keybindings).catch(() => undefined);
  }, [serialized]);

  // 勾选状态随设置变化推送(别的窗口改的设置经跨窗同步到达后同样推送,菜单是全应用共用的一份)。
  const autoSave = useSettingValue(FILES_AUTO_SAVE.id, FILES_AUTO_SAVE.default);
  useEffect(() => {
    // 推送失败只影响菜单勾选显示,不打扰用户(测试替身可能没有该方法:同样吞掉)
    void Promise.resolve()
      .then(() => coApi.window.setMenuChecked(menuCheckedState(autoSave)))
      .catch(() => undefined);
  }, [autoSave]);
}
