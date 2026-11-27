// 编码 / 行尾 / 缩进选择器(VSCode workbench.action.editor.changeEncoding / changeEOL / 状态栏缩进项的 Quick Pick)状态:共享 picker 切片 + 本次请求。
// 关闭只收起列表;「放弃更改并重新打开」确认框由 confirmReopen 驱动(选择器已关)。BDD: src/__tests__/editor-text-encoding/

import { create } from 'zustand';
import { createPickerSlice, type PickerSlice } from '../picker/picker-slice';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { useCommandPaletteStore } from '@/plugins/command-palette/store';
import { useOpenRecentStore } from '@/plugins/open-recent/store';
import { useThemePickerStore } from '@/plugins/theme-picker/store';
import type { TextEncodingId } from '../../../electron/shared/text-encoding';

export type EncodingPickRequest =
  /** 第一步:通过编码重新打开 / 通过编码保存(VSCode pickAction)。 */
  | { readonly kind: 'action'; readonly tabId: string }
  | { readonly kind: 'reopen'; readonly tabId: string }
  | { readonly kind: 'save'; readonly tabId: string }
  /** 打开非 UTF-8 文件失败(FS_UNKNOWN_ENCODING):选编码后按它打开(open 负责打开与失败提示)。 */
  | { readonly kind: 'open'; readonly name: string; readonly open: (encoding: TextEncodingId) => unknown }
  | { readonly kind: 'eol'; readonly tabId: string }
  /** 状态栏缩进项:使用空格缩进 / 使用 Tab 缩进 / 从内容中检测缩进方式 / 转换缩进(VSCode showIndentationPicker)。 */
  | { readonly kind: 'indent'; readonly tabId: string }
  /** 选缩进宽度 1..8(VSCode ChangeIndentationSizeAction;insertSpaces = 选定后用空格还是 tab)。 */
  | { readonly kind: 'indent-size'; readonly tabId: string; readonly insertSpaces: boolean };

export interface EncodingPickerState extends PickerSlice {
  readonly request: EncodingPickRequest | null;
  /** 脏 tab「通过编码重新打开」的确认(VSCode reopenWithEncodingWarning)。 */
  readonly confirmReopen: { readonly tabId: string; readonly encoding: TextEncodingId } | null;
  /** 打开选择器(或在打开着时换到下一步),query / 选中行重置。 */
  readonly show: (request: EncodingPickRequest, selectedIndex?: number) => void;
  readonly setConfirmReopen: (v: EncodingPickerState['confirmReopen']) => void;
}

export const useEncodingPickerStore = create<EncodingPickerState>((set, get) => {
  const slice = createPickerSlice(set);
  return {
    ...slice,
    request: null,
    confirmReopen: null,
    show: (request, selectedIndex = 0) => {
      get().open();
      set({ request, query: '', selectedIndex });
    },
    close: () => {
      slice.close();
      set((s) => (s.request === null ? s : { request: null }));
    },
    setConfirmReopen: (confirmReopen) => set({ confirmReopen }),
  };
});

/** 打开编码 / 行尾选择器(与其它选择器互斥,同 openThemePicker)。 */
export function showEncodingPicker(request: EncodingPickRequest, selectedIndex?: number): void {
  useQuickOpenStore.getState().close();
  useCommandPaletteStore.getState().close();
  useOpenRecentStore.getState().close();
  useThemePickerStore.getState().close();
  useEncodingPickerStore.getState().show(request, selectedIndex);
}

/** 打开文件因不是 UTF-8 而失败(FS_UNKNOWN_ENCODING):弹编码选择器,选定后调 open(encoding)(open 自己负责失败提示)。 */
export function promptOpenWithEncoding(name: string, open: (encoding: TextEncodingId) => unknown): void {
  showEncodingPicker({ kind: 'open', name, open });
}
