// 颜色主题选择器(VSCode workbench.action.selectTheme)的 Quick Pick 状态:共享 picker 切片;关闭(Esc / 确定 / 所在子窗关闭)
// 一律清掉预览 —— 未确定时即回到原主题。BDD: src/__tests__/theme-commands/

import { create } from 'zustand';
import { createPickerSlice, type PickerSlice } from '../picker/picker-slice';
import { setThemePreview } from '@/theme/ThemeProvider';

export const useThemePickerStore = create<PickerSlice>((set) => {
  const slice = createPickerSlice(set);
  return {
    ...slice,
    close: () => {
      setThemePreview(null);
      slice.close();
    },
  };
});
