// ⌘⇧P / Ctrl+Shift+P 全局开关命令面板(对齐 VSCode 2026-05)。
// 已 open 再按 → close;Esc / 遮罩点击 → 由 Modal 自身处理。
//
// 之前是 ⌘P,但 ⌘P 改为 Quick Open(VSCode 同款),CommandPalette 让位。
// shift 区分两个面板:不带 shift = Quick Open(文件) / 带 shift = 命令面板.

import { useEffect } from 'react';
import { useCommandPaletteStore } from './store';

export function useCommandPaletteHotkey(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘⇧P (mac) / Ctrl+Shift+P (others)
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === 'p'
      ) {
        e.preventDefault();
        const { isOpen, open, close } = useCommandPaletteStore.getState();
        if (isOpen) close();
        else open();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
}
