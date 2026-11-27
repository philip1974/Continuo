// mod+P 族的全局开关热键(命令面板 ⌘⇧P / Quick Open ⌘P 共用;此前两个 hook 逐行相同,只差 shift 与 store)。
// 已 open 再按 → close;Esc / 遮罩点击由 Modal 自身处理。shift 区分两个面板:不带 shift = Quick Open
// (文件),带 shift = 命令面板(对齐 VSCode)。两个面板互斥:打开一个时关掉另一个(占位文案「⌘⇧P 切到命令面板」
// 的语义;否则两个 Modal 叠加,执行命令 / Esc 后底下那个还开着挡住结果)。主窗与每个 popout 子窗各自监听:选择器画在
// 按键所在窗口(VSCode 同,见 picker-window;BDD: src/__tests__/popout-picker/)。

import { useEffect, useSyncExternalStore } from 'react';
import { canonicalHotkey, detectPlatform, type Platform } from '@/plugins/command-palette/format-hotkey';
import type { PickerSlice } from './picker-slice';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { resolveEffectiveHotkey, resolveEffectiveHotkeys } from '@/plugins/keybindings/keybindings-store';
import { hasOpenModalIn } from '@/design/Modal';
import { isInsideMenu } from '@/lib/menu-focus';
import { isImeComposing } from '@/design/ime';
import { getPopoutDocuments, runInCommandDocument, subscribePopoutDocuments } from '@/shell/dock/popout-documents';

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

/** 显示所有命令的附加默认键 F1(VSCode 同,各平台):不是保留键,进命令分发(window-commands 注册,终端让出)。 */
export const SHOW_COMMANDS_COMMAND = {
  id: PICKER_TOGGLE_COMMAND_IDS.command_palette,
  secondaryHotkeys: ['f1'] as readonly string[],
} as const;

/** 命令是保留键的归属命令 → 该保留键(hotkey 词汇);否则 undefined。 */
export function reservedHotkeyOfCommand(id: string): string | undefined {
  for (const name of Object.keys(PICKER_TOGGLE_COMMAND_IDS) as ReservedPickerHotkey[]) {
    if (PICKER_TOGGLE_COMMAND_IDS[name] === id) return PICKER_TOGGLE_HOTKEYS[name];
  }
  return undefined;
}

/**
 * 命令实际参与按键分发的 hotkey(全部,主键在前):生效绑定落在保留键上则视为未绑定;保留键归属命令的保留键与旧 override
 * 都不参与(键由 picker 监听处理),只有附加默认键(显示所有命令的 F1)参与分发。命令分发、终端让出判定共用 —— 否则一处
 * 跳过、一处仍认,同一键既打开 picker 又执行命令。设置页另显「未生效」标注。对外显示用 resolveDisplayHotkey。
 */
export function resolveActiveHotkeys(
  spec: Pick<CommandSpec, 'id' | 'hotkey' | 'secondaryHotkeys'>,
  overrides: Readonly<Record<string, string>>,
  platform: Platform = detectPlatform(),
): readonly string[] {
  const all =
    reservedHotkeyOfCommand(spec.id) !== undefined ? (spec.secondaryHotkeys ?? NO_HOTKEYS) : resolveEffectiveHotkeys(spec, overrides);
  let out: string[] | null = null;
  for (let i = 0; i < all.length; i++) {
    const reserved = reservedPickerHotkeyOf(all[i], platform) !== null;
    if (reserved && out === null) out = all.slice(0, i);
    else if (!reserved && out !== null) out.push(all[i]!);
  }
  return out ?? all;
}

const NO_HOTKEYS: readonly string[] = [];

/**
 * 命令实际参与分发的主键(界面显示的那条):生效绑定落在保留键上视为未绑定;保留键归属命令恒为 undefined(其保留键由 picker
 * 监听处理,显示走 resolveDisplayHotkey)。附加默认键见 resolveActiveHotkeys。
 */
export function resolveActiveHotkey(
  spec: Pick<CommandSpec, 'id' | 'hotkey' | 'secondaryHotkeys'>,
  overrides: Readonly<Record<string, string>>,
  platform: Platform = detectPlatform(),
): string | undefined {
  if (reservedHotkeyOfCommand(spec.id) !== undefined) return undefined;
  const effective = resolveEffectiveHotkey(spec, overrides);
  return reservedPickerHotkeyOf(effective, platform) === null ? effective : undefined;
}

/** 对外显示的 hotkey(命令面板、tooltip):保留键归属命令显示其保留键,其余同 resolveActiveHotkey(显示 ⌘P 就按得出)。 */
export function resolveDisplayHotkey(
  spec: Pick<CommandSpec, 'id' | 'hotkey' | 'secondaryHotkeys'>,
  overrides: Readonly<Record<string, string>>,
  platform: Platform = detectPlatform(),
): string | undefined {
  return reservedHotkeyOfCommand(spec.id) ?? resolveActiveHotkey(spec, overrides, platform);
}

function isPKey(key: string): boolean {
  return key === 'p' || key === 'P';
}

type PickerGetState = () => Pick<PickerSlice, 'isOpen' | 'hostDocument' | 'open' | 'close'>;

/** 当前挂载的 picker(互斥用:打开一个前关掉其余)。 */
const mountedPickers = new Set<PickerGetState>();

export function usePickerToggleHotkey(
  getState: PickerGetState,
  opts: { readonly shift: boolean },
): void {
  const { shift } = opts;
  const popoutDocs = useSyncExternalStore(subscribePopoutDocuments, getPopoutDocuments);
  useEffect(() => {
    mountedPickers.add(getState);
    return () => {
      mountedPickers.delete(getState);
    };
  }, [getState]);
  useEffect(() => {
    // 只认平台主修饰键:mac = Cmd(meta),其它 = Ctrl。
    //  - 非 mac 不认 meta:否则 Windows/Linux 的 Super/Win 键会误触发面板(跨平台审计 P2)。
    //  - mac 不认 Ctrl:Ctrl+P 是终端 readline 的「上一条历史」等 Control 序列,认了的话焦点在终端时
    //    shell 收到按键的同时面板也弹出来抢焦点(与 useCommandHotkeys 的 R15 规则一致)。
    const isMac = detectPlatform() === 'mac';
    const handlerFor = (doc: Document) => (e: KeyboardEvent): void => {
      // 输入法组字中的按键属于输入法,不当开关键(同全局命令分发 useCommandHotkeys)
      if (isImeComposing(e)) return;
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (mod && !e.altKey && e.shiftKey === shift && isPKey(e.key)) {
        // 选择器画在按键所在窗口(VSCode:Quick Input 画在触发它的窗口,见 picker-window)。picker 所在窗口 = hostDocument
        //(null = 主窗)。
        const here = doc === document ? null : doc;
        // 有别的 Modal(确认框 / 授权框)开着 → 不打开、不切换、不 preventDefault(对话框期间工作台快捷键不触发,
        // 对齐 VSCode)。picker 自己也是 Modal:只有它自己在本窗口开着时(再按关闭 / 互斥切换)扣掉这一层。picker 之上
        // 又叠了授权框时栈深 2 → 同样不动,免得切出的命令面板盖在授权框上。
        let pickerOpenHere = false;
        for (const picker of mountedPickers) {
          const p = picker();
          if (p.isOpen && p.hostDocument === here) pickerOpenHere = true;
        }
        if (hasOpenModalIn(doc, pickerOpenHere ? 1 : 0)) return;
        // 菜单开着(焦点在菜单内)→ 同样不动,按键留给菜单。
        if (isInsideMenu(e.target)) return;
        e.preventDefault();
        const { isOpen, hostDocument, open, close } = getState();
        if (isOpen && hostDocument === here) {
          close();
          return;
        }
        for (const other of mountedPickers) {
          if (other !== getState) other().close();
        }
        // 已在别的窗口开着 → 移到本窗口(open 按触发窗口重取 hostDocument)
        runInCommandDocument(doc, open);
      }
    };
    // 主窗与每个 popout 子窗各挂一个监听(子窗关闭 → popoutDocs 变化 → 移除旧监听)。
    const docs = [document, ...popoutDocs];
    const handlers = docs.map((doc) => {
      const handler = handlerFor(doc);
      doc.addEventListener('keydown', handler);
      return { doc, handler };
    });
    return () => {
      for (const { doc, handler } of handlers) doc.removeEventListener('keydown', handler);
    };
  }, [getState, shift, popoutDocs]);
}
