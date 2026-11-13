// 命令面板状态(M-Plugin v1.6)。Zustand vanilla,沿用 ADR-007。

import { create } from 'zustand';
import { createPickerSlice, type PickerSlice } from '../picker/picker-slice';

// 状态与 action 全部来自共享 picker 切片(open / close / setQuery / moveSelection / clampSelection)。
type CommandPaletteState = PickerSlice;

export const useCommandPaletteStore = create<CommandPaletteState>((set) =>
  createPickerSlice(set),
);
