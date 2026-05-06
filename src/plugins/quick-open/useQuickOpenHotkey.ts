// ⌘P / Ctrl+P 全局开关 Quick Open(VSCode 同款)。
// 已 open 再按 → close;Esc / 遮罩点击由 Modal 自身处理。
//
// 注意:之前 ⌘P 占了 CommandPalette,本次改为 Quick Open;CommandPalette
// 改用 ⌘⇧P(对齐 VSCode)。

import { useEffect } from 'react';
import { useQuickOpenStore } from './store';

export function useQuickOpenHotkey(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘P (mac) / Ctrl+P (others),不带 shift(带 shift 留给 CommandPalette)
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'p'
      ) {
        e.preventDefault();
        const { isOpen, open, close } = useQuickOpenStore.getState();
        if (isOpen) close();
        else open();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
}
