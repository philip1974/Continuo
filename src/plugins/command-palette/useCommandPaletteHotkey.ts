// ⌘P / Ctrl+P 全局开关命令面板(M-Plugin v1.6)。
// 已 open 再按 → close;Esc / 遮罩点击 → 由 Modal 自身处理。

import { useEffect } from 'react';
import { useCommandPaletteStore } from './store';

export function useCommandPaletteHotkey(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘P (mac) / Ctrl+P (others)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
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
