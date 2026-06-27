// ⌘P / Ctrl+P 全局开关 Quick Open(VSCode 同款)。
// 已 open 再按 → close;Esc / 遮罩点击由 Modal 自身处理。
//
// 注意:之前 ⌘P 占了 CommandPalette,本次改为 Quick Open;CommandPalette
// 改用 ⌘⇧P(对齐 VSCode)。

import { useEffect } from 'react';
import { useQuickOpenStore } from './store';
import { detectPlatform } from '@/plugins/command-palette/format-hotkey';

export function useQuickOpenHotkey(): void {
  useEffect(() => {
    // mac:Cmd(meta)是 mod;非 mac:只认 Ctrl —— 否则 Windows/Linux 的 Super/Win 键
    // (= metaKey)会误触发面板(跨平台审计 P2)。mac 仍兼容 Ctrl(行为不变)。
    const isMac = detectPlatform() === 'mac';
    const handler = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey || e.ctrlKey : e.ctrlKey;
      // mod+P,不带 shift(带 shift 留给 CommandPalette)
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') {
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
