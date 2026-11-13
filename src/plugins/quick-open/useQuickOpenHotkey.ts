// ⌘P / Ctrl+P 全局开关 Quick Open(VSCode 同款)。不带 shift(带 shift 留给命令面板 ⌘⇧P)。
// 机制在共享 usePickerToggleHotkey。

import { usePickerToggleHotkey } from '../picker/use-picker-toggle-hotkey';
import { useQuickOpenStore } from './store';

const WITHOUT_SHIFT = { shift: false } as const;

export function useQuickOpenHotkey(): void {
  usePickerToggleHotkey(useQuickOpenStore.getState, WITHOUT_SHIFT);
}
