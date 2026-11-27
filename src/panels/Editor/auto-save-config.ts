// 自动保存配置(对照 VSCode files.autoSave / files.autoSaveDelay,filesConfigurationService.getAutoSaveMode / toggleAutoSave)。
// 每个文件的生效模式 = Markdown 语言级覆盖(autoSave.markdown.enabled,默认开 = 停手 autoSave.delayMs 后保存)优先,其余跟随
// files.autoSave;无标题文件从不自动保存。默认行为因此不变:Markdown 停手 2 秒自动保存,代码不自动保存。
// BDD: src/__tests__/files-auto-save/

import { useMemo } from 'react';
import { isUntitledPath } from '../../../electron/shared/untitled';
import { isMarkdownPath } from './editor-path-utils';
import {
  AUTO_SAVE_DELAY_MS,
  AUTO_SAVE_MARKDOWN_ENABLED,
  FILES_AUTO_SAVE,
  FILES_AUTO_SAVE_DELAY,
  type FilesAutoSaveMode,
} from '@/plugins/settings/core-setting-specs';
import { getStoredSettingValue, useSettingValue, useSettingsValuesStore } from '@/plugins/settings/values-store';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';

export interface AutoSaveSettings {
  /** files.autoSave */
  readonly mode: FilesAutoSaveMode;
  /** files.autoSaveDelay */
  readonly delayMs: number;
  /** autoSave.markdown.enabled:Markdown 覆盖为 afterDelay */
  readonly markdown: boolean;
  /** autoSave.delayMs:Markdown 覆盖的延迟 */
  readonly markdownDelayMs: number;
}

export const DEFAULT_AUTO_SAVE_SETTINGS: AutoSaveSettings = {
  mode: FILES_AUTO_SAVE.default,
  delayMs: FILES_AUTO_SAVE_DELAY.default,
  markdown: AUTO_SAVE_MARKDOWN_ENABLED.default,
  markdownDelayMs: AUTO_SAVE_DELAY_MS.default,
};

export type ResolvedAutoSave =
  | { readonly mode: 'off' }
  | { readonly mode: 'afterDelay'; readonly delayMs: number }
  | { readonly mode: 'onFocusChange' | 'onWindowChange' };

const OFF: ResolvedAutoSave = { mode: 'off' };

/** filePath 的生效自动保存模式。 */
export function resolveAutoSave(filePath: string | null, s: AutoSaveSettings): ResolvedAutoSave {
  // 无标题文件不自动保存(VSCode editorAutoSave:never auto save untitled working copies;它也没有路径可写)
  if (!filePath || isUntitledPath(filePath)) return OFF;
  if (s.markdown && isMarkdownPath(filePath)) return { mode: 'afterDelay', delayMs: s.markdownDelayMs };
  if (s.mode === 'afterDelay') return { mode: 'afterDelay', delayMs: s.delayMs };
  return s.mode === 'off' ? OFF : { mode: s.mode };
}

/** 窗口失焦时该保存的模式(VSCode:WINDOW_CHANGE 对 onFocusChange 与 onWindowChange 都触发)。 */
export function savesOnWindowBlur(r: ResolvedAutoSave): boolean {
  return r.mode === 'onFocusChange' || r.mode === 'onWindowChange';
}

/**
 * 关闭脏 tab 时直接保存、不弹「是否保存」确认框的模式(VSCode editorGroupView.doHandleCloseConfirmation):onFocusChange 总是
 *(对话框会抢走焦点,microsoft/vscode#108752);onWindowChange 只在 Windows / Linux(原生对话框会让窗口失焦,#134250),macOS 照常弹框。
 * 无标题文件 resolveAutoSave 已是 off。保存失败时调用方改弹确认框(VSCode skipAutoSave)。
 */
export function savesOnClose(r: ResolvedAutoSave, isMac: boolean): boolean {
  return r.mode === 'onFocusChange' || (r.mode === 'onWindowChange' && !isMac);
}

/** React hook:四个自动保存设置(跨窗同步经 values-store)。 */
export function useAutoSaveSettings(): AutoSaveSettings {
  const mode = useSettingValue(FILES_AUTO_SAVE.id, FILES_AUTO_SAVE.default);
  const delayMs = useSettingValue(FILES_AUTO_SAVE_DELAY.id, FILES_AUTO_SAVE_DELAY.default);
  const markdown = useSettingValue(AUTO_SAVE_MARKDOWN_ENABLED.id, AUTO_SAVE_MARKDOWN_ENABLED.default);
  const markdownDelayMs = useSettingValue(AUTO_SAVE_DELAY_MS.id, AUTO_SAVE_DELAY_MS.default);
  return useMemo(() => ({ mode, delayMs, markdown, markdownDelayMs }), [mode, delayMs, markdown, markdownDelayMs]);
}

/** 切换自动保存(VSCode toggleAutoSave):afterDelay / onFocusChange / onWindowChange → off,否则 → afterDelay。不动 Markdown 覆盖。 */
export function toggleAutoSave(): void {
  const cur = getStoredSettingValue(FILES_AUTO_SAVE.id) ?? FILES_AUTO_SAVE.default;
  const on = cur === 'afterDelay' || cur === 'onFocusChange' || cur === 'onWindowChange';
  useSettingsValuesStore.getState().setValue(FILES_AUTO_SAVE.id, on ? 'off' : 'afterDelay');
}

export const TOGGLE_AUTO_SAVE_COMMAND_ID = 'workbench.action.toggleAutoSave';

/** 「文件:切换自动保存」(文件菜单「自动保存」勾选项同一命令)。 */
export function autoSaveCommandSpecs(): CommandSpec[] {
  return [
    {
      id: TOGGLE_AUTO_SAVE_COMMAND_ID,
      title: 'Toggle Auto Save',
      titleKey: 'commands.file.toggle_auto_save.title',
      category: 'File',
      categoryKey: 'commands.file.category',
      fn: toggleAutoSave,
    },
  ];
}
