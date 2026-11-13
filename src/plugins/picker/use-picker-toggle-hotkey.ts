// mod+P 族的全局开关热键(命令面板 ⌘⇧P / Quick Open ⌘P 共用;此前两个 hook 逐行相同,只差 shift 与 store)。
// 已 open 再按 → close;Esc / 遮罩点击由 Modal 自身处理。shift 区分两个面板:不带 shift = Quick Open
// (文件),带 shift = 命令面板(对齐 VSCode)。

import { useEffect } from 'react';
import { detectPlatform } from '@/plugins/command-palette/format-hotkey';
import type { PickerSlice } from './picker-slice';

function isPKey(key: string): boolean {
  return key === 'p' || key === 'P';
}

export function usePickerToggleHotkey(
  getState: () => Pick<PickerSlice, 'isOpen' | 'open' | 'close'>,
  opts: { readonly shift: boolean },
): void {
  const { shift } = opts;
  useEffect(() => {
    // mac:Cmd(meta)是 mod;非 mac:只认 Ctrl —— 否则 Windows/Linux 的 Super/Win 键
    // (= metaKey)会误触发面板(跨平台审计 P2)。mac 仍兼容 Ctrl(行为不变)。
    const isMac = detectPlatform() === 'mac';
    const handler = (e: KeyboardEvent): void => {
      const mod = isMac ? e.metaKey || e.ctrlKey : e.ctrlKey;
      if (mod && e.shiftKey === shift && isPKey(e.key)) {
        e.preventDefault();
        const { isOpen, open, close } = getState();
        if (isOpen) close();
        else open();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [getState, shift]);
}
