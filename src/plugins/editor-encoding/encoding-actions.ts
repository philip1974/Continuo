// 更改文件编码 / 更改行尾序列(VSCode workbench.action.editor.changeEncoding / changeEOL;状态栏编码 / 行尾项点击同一入口)。
// - 编码:第一步选「通过编码重新打开 / 通过编码保存」,第二步选编码。重新打开脏 tab 先确认「放弃更改并重新打开」(VSCode 同);
//   保存遇表示不了的字符 → 提示,不写(VSCode / iconv 会静默写成 `?`)。
// - 行尾:LF / CRLF,整篇换行统一改写,tab 变脏,保存写回(VSCode pushEOL)。
// - 打开非 UTF-8 文件失败(FS_UNKNOWN_ENCODING)→ 直接弹编码选择器,选定后按该编码打开(VSCode 是二进制占位编辑器里的
//  「仍然打开」,随后可通过编码重新打开;这里合成一步)。
// BDD: src/__tests__/editor-text-encoding/

import { t } from '@/i18n';
import { notify } from '@/notifications/notify';
import { fileFailureText, notifySaveFailed } from '@/notifications/notify-open-failed';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { useEditorStore } from '@/stores/editor.store';
import { activeGroupTab, saveHotkeyLabel } from '@/panels/Editor/editor-commands';
import { EDITOR_DISK_CHANGED, reopenWithEncoding, saveFile } from '@/panels/Editor/editor-file-actions';
import { editorFileDeps } from '@/panels/Editor/editor-file-deps';
import { isImagePreviewPath } from '@/panels/Editor/editor-image';
import { findEditorFileTabById } from '@/panels/Editor/editor-tab-lookup';
import { flushEditorWriteBacks } from '@/panels/Editor/editor-writeback-registry';
import { editorTabTitle, isUntitledPath } from '@/panels/Editor/untitled';
import { convertLineEndings, lineEndingOf, tabEncodingOf, type LineEnding } from '@/panels/Editor/editor-encoding';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import { isTextEncodingId, TEXT_ENCODINGS, type TextEncodingId } from '../../../electron/shared/text-encoding';
import { encodingPickItems } from './encoding-picks';
import { showEncodingPicker as show, useEncodingPickerStore, type EncodingPickRequest } from './store';
import { acceptIndentationPick } from './indentation-actions';

export const CHANGE_ENCODING_COMMAND_ID = 'workbench.action.editor.changeEncoding';
export const CHANGE_EOL_COMMAND_ID = 'workbench.action.editor.changeEOL';

/** 可改编码 / 行尾的文本 tab(图片 tab 只读、内容是 stat 指纹)。 */
function textTab(tabId: string | undefined) {
  const tab =
    tabId === undefined ? activeGroupTab() : findEditorFileTabById(useEditorStore.getState().tabs, tabId);
  return tab && !isImagePreviewPath(tab.filePath) ? tab : null;
}

/** 更改文件编码(tabId 缺省 = 触发窗口编辑器组的活动 tab;无文本 tab → 无操作)。 */
// 无标题文件没有磁盘内容可重新读:跳过第一步,直接选「通过编码保存」的编码(VSCode ChangeEncodingAction 对 untitled 同),
// 选定 = 设成 tab 的编码,首次另存为按它写盘(saveWithEncoding)。
export function openChangeEncoding(tabId?: string): void {
  const tab = textTab(tabId);
  if (!tab) return;
  if (!isUntitledPath(tab.filePath)) {
    show({ kind: 'action', tabId: tab.id });
    return;
  }
  const request = { kind: 'save', tabId: tab.id } as const;
  show(request, encodingPickItems(request, { encoding: tabEncodingOf(tab) }).selectedIndex);
}

/** 更改行尾序列(同上),选中行落在当前行尾。 */
export function openChangeEol(tabId?: string): void {
  const tab = textTab(tabId);
  if (!tab) return;
  const request = { kind: 'eol', tabId: tab.id } as const;
  show(request, encodingPickItems(request, { eol: lineEndingOf(tab.content) }).selectedIndex);
}

/** 选择器里确定了一项(Enter / 单击)。 */
export function acceptEncodingPick(request: EncodingPickRequest, id: string): void {
  const store = useEncodingPickerStore.getState();
  // 状态栏缩进项 / 缩进宽度(BDD: src/__tests__/editor-indentation/)
  if (request.kind === 'indent' || request.kind === 'indent-size') {
    acceptIndentationPick(request, id);
    return;
  }
  if (request.kind === 'action') {
    if (id !== 'reopen' && id !== 'save') return;
    const tab = textTab(request.tabId);
    if (!tab) return store.close();
    const next = { kind: id, tabId: tab.id } as const;
    store.show(next, encodingPickItems(next, { encoding: tabEncodingOf(tab) }).selectedIndex);
    return;
  }
  store.close();
  if (request.kind === 'eol') {
    if (id === 'LF' || id === 'CRLF') changeLineEnding(request.tabId, id);
    return;
  }
  if (!isTextEncodingId(id)) return;
  if (request.kind === 'open') {
    request.open(id);
    return;
  }
  if (request.kind === 'save') {
    void saveWithEncoding(request.tabId, id);
    return;
  }
  // 重新打开:先把编辑器里尚未上抛的输入写回 store,再按是否脏决定要不要确认
  flushEditorWriteBacks([request.tabId]);
  const tab = textTab(request.tabId);
  if (!tab) return;
  if (!tab.dirty) {
    // 编码没变且没有未保存的修改 → 无事可做(VSCode isNewEncoding)
    if (id === tabEncodingOf(tab)) return;
    void runReopen(tab.id, id);
    return;
  }
  store.setConfirmReopen({ tabId: tab.id, encoding: id });
}

/** 「放弃更改并重新打开」确认后:按所选编码重读(未保存的修改丢弃)。 */
export async function runReopen(tabId: string, encoding: TextEncodingId): Promise<void> {
  const tab = textTab(tabId);
  if (!tab) return;
  const r = await reopenWithEncoding(tabId, encoding, editorFileDeps);
  if (r.ok) return;
  notify.error(fileFailureText(t('encoding_picker.reopen_failed'), editorTabTitle(tab.filePath), r), { code: r.code });
}

async function saveWithEncoding(tabId: string, encoding: TextEncodingId): Promise<void> {
  flushEditorWriteBacks([tabId]);
  const tab = textTab(tabId);
  if (!tab) return;
  // 无标题文件:只改编码,不弹另存为(VSCode untitled setEncoding(Encode) 同);之后另存为按该编码写
  if (isUntitledPath(tab.filePath)) {
    useEditorStore.getState().setEncoding(tabId, encoding);
    return;
  }
  const r = await saveFile(tabId, editorFileDeps, { encoding });
  if (r.ok) return;
  const name = editorTabTitle(tab.filePath);
  if (r.code === ERROR_CODES.FS_UNENCODABLE) {
    notify.error(
      t('common.label_detail', {
        label: `${t('editor.save_failed')} ${name}`,
        detail: t('encoding_picker.unencodable', { encoding: TEXT_ENCODINGS[encoding].labelLong }),
      }),
      { code: r.code },
    );
    return;
  }
  if (r.code === EDITOR_DISK_CHANGED) {
    notify.error(
      t('common.label_detail', {
        label: `${t('editor.save_failed')} ${name}`,
        detail: t('errors.EDITOR_DISK_CHANGED', { hotkey: saveHotkeyLabel() }),
      }),
      { code: r.code },
    );
    return;
  }
  notifySaveFailed(name, r, undefined, tab.filePath);
}

/** 整篇换行改成 eol(先写回编辑器里尚未上抛的输入);内容不变则不动。 */
export function changeLineEnding(tabId: string, eol: LineEnding): void {
  flushEditorWriteBacks([tabId]);
  const tab = textTab(tabId);
  if (!tab) return;
  const next = convertLineEndings(tab.content, eol);
  if (next !== tab.content) useEditorStore.getState().updateContent(tab.id, next);
}

export function encodingCommandSpecs(): CommandSpec[] {
  return [
    {
      id: CHANGE_ENCODING_COMMAND_ID,
      title: 'Change File Encoding',
      titleKey: 'commands.editor.change_encoding.title',
      fn: () => openChangeEncoding(),
    },
    {
      id: CHANGE_EOL_COMMAND_ID,
      title: 'Change End of Line Sequence',
      titleKey: 'commands.editor.change_eol.title',
      fn: () => openChangeEol(),
    },
  ];
}
