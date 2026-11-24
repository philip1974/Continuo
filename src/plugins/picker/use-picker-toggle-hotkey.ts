// mod+P 族的全局开关热键(命令面板 ⌘⇧P / Quick Open ⌘P 共用;此前两个 hook 逐行相同,只差 shift 与 store)。
// 已 open 再按 → close;Esc / 遮罩点击由 Modal 自身处理。shift 区分两个面板:不带 shift = Quick Open
// (文件),带 shift = 命令面板(对齐 VSCode)。两个面板互斥:打开一个时关掉另一个(占位文案「⌘⇧P 切到命令面板」
// 的语义;否则两个 Modal 叠加,执行命令 / Esc 后底下那个还开着挡住结果)。

import { useEffect } from 'react';
import { detectPlatform } from '@/plugins/command-palette/format-hotkey';
import type { PickerSlice } from './picker-slice';

/**
 * 这两个组合由下方 document 监听写死处理,不在 CommandRegistry 里:改绑命令时的冲突检测
 * (KeybindingCaptureModal)据此把它们当保留键。'mod' 的平台语义与下方 handler 同一规则
 * (mac = 仅 Cmd、其它 = 仅 Ctrl;不认 alt)。
 */
export const PICKER_TOGGLE_HOTKEYS = {
  quick_open: 'mod+p',
  command_palette: 'mod+shift+p',
} as const;

function isPKey(key: string): boolean {
  return key === 'p' || key === 'P';
}

type PickerGetState = () => Pick<PickerSlice, 'isOpen' | 'open' | 'close'>;

/** 当前挂载的 picker(互斥用:打开一个前关掉其余)。 */
const mountedPickers = new Set<PickerGetState>();

export function usePickerToggleHotkey(
  getState: PickerGetState,
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
        if (isOpen) {
          close();
          return;
        }
        for (const other of mountedPickers) {
          if (other !== getState) other().close();
        }
        open();
      }
    };
    mountedPickers.add(getState);
    // 只挂主窗 document,不挂 popout 子窗:picker 是主窗 App 层的 Modal,从子窗打开时画在主窗、焦点却留在子窗
    //(无激活主窗的通路)→ 接着输入的字进了子窗的编辑器 / 终端,且该 Modal 在子窗里 Esc 关不掉,比不响应更糟。
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      mountedPickers.delete(getState);
    };
  }, [getState, shift]);
}
