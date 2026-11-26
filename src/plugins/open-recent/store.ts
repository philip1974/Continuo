// 打开最近的文件夹(VSCode workbench.action.openRecent,⌃R)的 Quick Pick 状态:共享 picker 切片(open / close / 查询 / 选中行)。
// BDD: src/__tests__/workbench-missing-commands/

import { create } from 'zustand';
import { createPickerSlice, type PickerSlice } from '../picker/picker-slice';

export const useOpenRecentStore = create<PickerSlice>((set) => createPickerSlice(set));
