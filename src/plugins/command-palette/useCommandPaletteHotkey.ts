// ⌘⇧P / Ctrl+Shift+P 全局开关命令面板(对齐 VSCode 2026-05)。
// 已 open 再按 → close;Esc / 遮罩点击 → 由 Modal 自身处理。
//
// 之前是 ⌘P,但 ⌘P 改为 Quick Open(VSCode 同款),CommandPalette 让位。
// shift 区分两个面板:不带 shift = Quick Open(文件) / 带 shift = 命令面板.

import { useEffect } from 'react';
import { useCommandPaletteStore } from './store';
import { detectPlatform } from './format-hotkey';

export function useCommandPaletteHotkey(): void {
  useEffect(() => {
    // mac:Cmd(meta)是 mod;非 mac:只认 Ctrl —— 否则 Windows/Linux 的 Super/Win 键
    // (= metaKey)会误触发面板(跨平台审计 P2)。mac 仍兼容 Ctrl(行为不变)。
    const isMac = detectPlatform() === 'mac';
    const handler = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey || e.ctrlKey : e.ctrlKey;
      // mod+Shift+P
      if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
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
