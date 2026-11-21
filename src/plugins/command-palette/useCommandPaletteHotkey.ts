// ⌘⇧P / Ctrl+Shift+P 全局开关命令面板(对齐 VSCode 2026-05)。
// ⌘P 留给 Quick Open(文件);带 shift = 命令面板。机制在共享 usePickerToggleHotkey。

import { usePickerToggleHotkey } from '../picker/use-picker-toggle-hotkey';
import { useCommandPaletteStore } from './store';

const WITH_SHIFT = { shift: true } as const;

export function useCommandPaletteHotkey(): void {
  usePickerToggleHotkey(useCommandPaletteStore.getState, WITH_SHIFT);
}
