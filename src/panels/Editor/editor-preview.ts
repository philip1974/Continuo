// 预览编辑器(VSCode workbench.editor.enablePreview / workbench.action.keepEditor)。预览 tab 的状态在 editor.store 的
// previewTabs(每组至多一个);本模块只放设置读取、设置关闭时全部转常驻、「保留编辑器」命令的实现。
// BDD: src/__tests__/editor-preview-tab/

import { groupActiveTabIdOf, useEditorStore } from '@/stores/editor.store';
import { EDITOR_ENABLE_PREVIEW } from '@/plugins/settings/core-setting-specs';
import { getStoredSettingValue, useSettingsValuesStore } from '@/plugins/settings/values-store';
import { commandEditorGroupId } from './editor-groups-actions';

/** 命令 id(VSCode 同;默认键 ⌘K Enter 是组合键,Continuo 不支持 → 无默认键,只进命令面板)。 */
export const KEEP_EDITOR_COMMAND_ID = 'workbench.action.keepEditor';

/** 设置 workbench.editor.enablePreview 当前值(未存 → 默认开)。 */
export function isEditorPreviewEnabled(): boolean {
  return (getStoredSettingValue(EDITOR_ENABLE_PREVIEW.id) ?? EDITOR_ENABLE_PREVIEW.default) === true;
}

/** 「保留编辑器」:触发窗口的编辑器组的活动 tab 转为常驻(不是预览 tab → no-op)。 */
export function keepActiveEditor(): void {
  const groupId = commandEditorGroupId();
  if (groupId === undefined) return;
  const s = useEditorStore.getState();
  const id = groupActiveTabIdOf(s, groupId);
  if (id !== null) s.keepTab(id, groupId);
}

/** 设置关闭 → 已有的预览 tab 全部转常驻(VSCode 同);返回取消订阅。 */
export function installEditorPreviewSettingSync(): () => void {
  return useSettingsValuesStore.subscribe(() => {
    if (isEditorPreviewEnabled()) return;
    const s = useEditorStore.getState();
    for (const id of new Set(s.previewTabs.values())) s.keepTab(id);
  });
}
