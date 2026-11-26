// mod+P 族的全局开关热键(命令面板 ⌘⇧P / Quick Open ⌘P 共用;此前两个 hook 逐行相同,只差 shift 与 store)。
// 已 open 再按 → close;Esc / 遮罩点击由 Modal 自身处理。shift 区分两个面板:不带 shift = Quick Open
// (文件),带 shift = 命令面板(对齐 VSCode)。两个面板互斥:打开一个时关掉另一个(占位文案「⌘⇧P 切到命令面板」
// 的语义;否则两个 Modal 叠加,执行命令 / Esc 后底下那个还开着挡住结果)。

import { useEffect } from 'react';
import { canonicalHotkey, detectPlatform, type Platform } from '@/plugins/command-palette/format-hotkey';
import type { PickerSlice } from './picker-slice';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { resolveEffectiveHotkey } from '@/plugins/keybindings/keybindings-store';
import { hasOpenModalIn } from '@/design/Modal';
import { isInsideMenu } from '@/lib/menu-focus';

/**
 * 这两个组合由下方 document 监听写死处理,不在 CommandRegistry 里:改绑命令时的冲突检测
 * (KeybindingCaptureModal)据此把它们当保留键。'mod' 的平台语义与下方 handler 同一规则
 * (mac = 仅 Cmd、其它 = 仅 Ctrl;不认 alt)。
 */
export const PICKER_TOGGLE_HOTKEYS = {
  quick_open: 'mod+p',
  command_palette: 'mod+shift+p',
} as const;

export type ReservedPickerHotkey = keyof typeof PICKER_TOGGLE_HOTKEYS;

/**
 * combo 是否撞上 Quick Open / 命令面板的保留键(⌘P / ⌘⇧P,平台感知,与下方监听同一判定)。录键弹窗拒绝保存、命令分发
 * 忽略此类绑定(含升级前已存的 override)、快捷键设置页标注「保留键,未生效」—— 三处共用。
 */
export function reservedPickerHotkeyOf(
  combo: string | null | undefined,
  platform: Platform = detectPlatform(),
): ReservedPickerHotkey | null {
  if (!combo) return null;
  const c = canonicalHotkey(combo, platform);
  for (const name of Object.keys(PICKER_TOGGLE_HOTKEYS) as ReservedPickerHotkey[]) {
    if (canonicalHotkey(PICKER_TOGGLE_HOTKEYS[name], platform) === c) return name;
  }
  return null;
}

/**
 * 保留键的归属命令(VSCode 同 id):命令面板 / 快捷键设置页 / tooltip 显示该键(VSCode「转到文件… ⌘P」),但不进命令分发 ——
 * 按键只由下方 document 监听处理,否则一键两动作。设置页标「保留键，不可更改」。BDD: src/__tests__/reserved-command-hotkeys/
 */
export const PICKER_TOGGLE_COMMAND_IDS: Readonly<Record<ReservedPickerHotkey, string>> = {
  quick_open: 'workbench.action.quickOpen',
  command_palette: 'workbench.action.showCommands',
};

/** 命令是保留键的归属命令 → 该保留键(hotkey 词汇);否则 undefined。 */
export function reservedHotkeyOfCommand(id: string): string | undefined {
  for (const name of Object.keys(PICKER_TOGGLE_COMMAND_IDS) as ReservedPickerHotkey[]) {
    if (PICKER_TOGGLE_COMMAND_IDS[name] === id) return PICKER_TOGGLE_HOTKEYS[name];
  }
  return undefined;
}

/**
 * 命令实际参与按键分发的 hotkey:生效绑定落在保留键上则视为未绑定;保留键归属命令恒为 undefined(键由 picker 监听处理,
 * 旧 override 也不响应)。命令分发、终端让出判定共用 —— 否则一处跳过、一处仍认,同一键既打开 picker 又执行命令。
 * 设置页另显「未生效」标注。对外显示用 resolveDisplayHotkey。
 */
export function resolveActiveHotkey(
  spec: Pick<CommandSpec, 'id' | 'hotkey'>,
  overrides: Readonly<Record<string, string>>,
  platform: Platform = detectPlatform(),
): string | undefined {
  if (reservedHotkeyOfCommand(spec.id) !== undefined) return undefined;
  const effective = resolveEffectiveHotkey(spec, overrides);
  return reservedPickerHotkeyOf(effective, platform) === null ? effective : undefined;
}

/** 对外显示的 hotkey(命令面板、tooltip):保留键归属命令显示其保留键,其余同 resolveActiveHotkey(显示 ⌘P 就按得出)。 */
export function resolveDisplayHotkey(
  spec: Pick<CommandSpec, 'id' | 'hotkey'>,
  overrides: Readonly<Record<string, string>>,
  platform: Platform = detectPlatform(),
): string | undefined {
  return reservedHotkeyOfCommand(spec.id) ?? resolveActiveHotkey(spec, overrides, platform);
}

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
        // 有别的 Modal(确认框 / 授权框)开着 → 不打开、不切换、不 preventDefault(对话框期间工作台快捷键不触发,
        // 对齐 VSCode)。picker 自己也是 Modal:只有它自己开着时(再按关闭 / 互斥切换)扣掉这一层。picker 之上
        // 又叠了授权框时栈深 2 → 同样不动,免得切出的命令面板盖在授权框上。
        let pickerOpen = false;
        for (const picker of mountedPickers) if (picker().isOpen) pickerOpen = true;
        if (hasOpenModalIn(document, pickerOpen ? 1 : 0)) return;
        // 菜单开着(焦点在菜单内)→ 同样不动,按键留给菜单。
        if (isInsideMenu(e.target)) return;
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
