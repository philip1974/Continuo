// 转到定义有多个结果时的选择器状态(VSCode 默认 peek 列出全部定义;本项目没有 peek,用 Quick Pick 式选择器):共享 picker 切片 +
// 结果列表。打开时关掉其它选择器(同一时刻只有一个)。BDD: src/__tests__/editor-go-to-definition/

import { create } from 'zustand';
import { createPickerSlice, type PickerSlice } from '../picker/picker-slice';
import { useQuickOpenStore } from '../quick-open/store';
import { useCommandPaletteStore } from '../command-palette/store';
import { useOpenRecentStore } from '../open-recent/store';
import { useThemePickerStore } from '../theme-picker/store';
import { useSwitchWindowStore } from '../switch-window/store';
import type { TsLocation } from '../../../electron/shared/ts-language';

export interface DefinitionPickerState extends PickerSlice {
  locations: readonly TsLocation[];
  show: (locations: readonly TsLocation[]) => void;
}

export const useDefinitionPickerStore = create<DefinitionPickerState>((set) => {
  const slice = createPickerSlice(set);
  return {
    ...slice,
    locations: [],
    show: (locations) => {
      useQuickOpenStore.getState().close();
      useCommandPaletteStore.getState().close();
      useOpenRecentStore.getState().close();
      useThemePickerStore.getState().close();
      useSwitchWindowStore.getState().close();
      slice.open();
      set({ locations });
    },
  };
});
