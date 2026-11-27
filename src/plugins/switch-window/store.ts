// 切换窗口(VSCode workbench.action.switchWindow)的 Quick Pick 状态:共享 picker 切片 + 打开时向 main 取的窗口列表
//(window:list-windows;各主窗口及其 popout 子窗)。BDD: src/__tests__/switch-window/

import { create } from 'zustand';
import { coApi } from '@/lib/co-api';
import { notifyFailure, notifyThrownError } from '@/notifications/notify-thrown-error';
import { createPickerSlice, type PickerSlice } from '../picker/picker-slice';
import type { WindowSwitchEntry } from '../../../electron/shared/window-channels';

export interface SwitchWindowState extends PickerSlice {
  /** 窗口列表(打开后取回前 / 取失败 → null)。 */
  windows: readonly WindowSwitchEntry[] | null;
  /** 打开并取窗口列表;取回后选中当前窗口的下一个(VSCode activeItem)。 */
  show: () => void;
}

// 每次打开的代际:迟到的列表(期间已关闭 / 重新打开)丢弃。
let generation = 0;

/** VSCode:初始选中当前窗口之后的那个窗口(当前是最后一个 / 找不到 → 第一个)。 */
export function initialSwitchWindowIndex(windows: readonly WindowSwitchEntry[]): number {
  const i = windows.findIndex((w) => w.current);
  return i >= 0 && i + 1 < windows.length ? i + 1 : 0;
}

export const useSwitchWindowStore = create<SwitchWindowState>((set, get) => {
  const slice = createPickerSlice(set);
  return {
    ...slice,
    windows: null,
    close: () => {
      generation++;
      slice.close();
    },
    show: () => {
      const my = ++generation;
      slice.open();
      set({ windows: null });
      // 当前窗口:选择器画在哪个窗口(popout 子窗里触发 → 那个子窗,按 window.open 名让 main 认出)
      const name = get().hostDocument?.defaultView?.name;
      const request = name ? coApi.window.listWindows({ popoutName: name }) : coApi.window.listWindows();
      void request.then(
        (r) => {
          if (my !== generation) return;
          if (!r.ok) {
            notifyFailure(r);
            get().close();
            return;
          }
          set({ windows: r.data, selectedIndex: initialSwitchWindowIndex(r.data) });
        },
        (err: unknown) => {
          if (my !== generation) return;
          notifyThrownError(err);
          get().close();
        },
      );
    },
  };
});
