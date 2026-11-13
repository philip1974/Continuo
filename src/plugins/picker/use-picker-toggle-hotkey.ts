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
    // 只认平台主修饰键:mac = Cmd(meta),其它 = Ctrl。
    //  - 非 mac 不认 meta:否则 Windows/Linux 的 Super/Win 键会误触发面板(跨平台审计 P2)。
    //  - mac 不认 Ctrl:Ctrl+P 是终端 readline 的「上一条历史」等 Control 序列,认了的话焦点在终端时
    //    shell 收到按键的同时面板也弹出来抢焦点(与 useCommandHotkeys 的 R15 规则一致)。
    const isMac = detectPlatform() === 'mac';
    const handler = (e: KeyboardEvent): void => {
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (mod && !e.altKey && e.shiftKey === shift && isPKey(e.key)) {
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
