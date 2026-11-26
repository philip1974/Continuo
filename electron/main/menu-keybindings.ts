// 应用菜单的键位显示(对齐 VSCode:菜单键位由渲染进程的 keybinding service 解析后推给主进程,菜单随之重建)。
// renderer 推送菜单命令当前生效的主键(归一后的 hotkey:`meta+ctrl+alt+shift+<e.key 小写名>`,见 canonicalHotkey;
// 改键 / 解绑 / 冲突落败后为 null),这里换算成 Electron accelerator。accelerator 只作显示(registerAccelerator: false;
// macOS 上该选项无效,accelerator 触发的点击由 renderer 按上下文重新判定,见 MenuCommandPayload.viaKey)。
// BDD: src/__tests__/app-menu-bar/

import { isMenuCommandId, MENU_HOTKEY_MAX, type MenuCommandId } from '../shared/window-channels';

const MAC_MODIFIERS: Readonly<Record<string, string>> = { meta: 'Command', ctrl: 'Control', alt: 'Alt', shift: 'Shift' };
const OTHER_MODIFIERS: Readonly<Record<string, string>> = { meta: 'Super', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };

// e.key 小写名 → Electron accelerator 键名(https://www.electronjs.org/docs/latest/api/accelerator)。
const NAMED_KEYS: Readonly<Record<string, string>> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  enter: 'Return',
  escape: 'Escape',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  '+': 'Plus',
};

// 直接可用的单字符主键(字母 / 数字另判)。
const PUNCTUATION = new Set(['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`']);

function acceleratorKey(key: string): string | undefined {
  if (Object.hasOwn(NAMED_KEYS, key)) return NAMED_KEYS[key];
  if (/^[a-z0-9]$/.test(key)) return key.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return key.toUpperCase();
  if (/^numpad[0-9]$/.test(key)) return `num${key.slice('numpad'.length)}`;
  return PUNCTUATION.has(key) ? key : undefined;
}

/** 归一后的 hotkey → Electron accelerator;无法表示(未知修饰键 / 主键)→ undefined(菜单项不显示键位)。 */
export function hotkeyToAccelerator(canonical: string, isMac: boolean): string | undefined {
  const parts = canonical.split('+');
  // 主键本身是 '+'(canonical 'meta++'):split 得到末尾两个空段
  const key = canonical.endsWith('++') ? '+' : parts.pop();
  if (canonical.endsWith('++')) parts.splice(parts.length - 2);
  if (!key) return undefined;
  const names = isMac ? MAC_MODIFIERS : OTHER_MODIFIERS;
  const out: string[] = [];
  for (const mod of parts) {
    if (!Object.hasOwn(names, mod)) return undefined;
    out.push(names[mod]!);
  }
  const k = acceleratorKey(key);
  return k === undefined ? undefined : [...out, k].join('+');
}

let current: ReadonlyMap<MenuCommandId, string> = new Map();

/**
 * 记下 renderer 推送的生效键位(整表替换;未登记的 id / 非字符串 / 超长值忽略)。返回是否有变化(有变化才重建菜单)。
 */
export function setMenuKeybindings(raw: Readonly<Record<string, unknown>>): boolean {
  const next = new Map<MenuCommandId, string>();
  for (const [id, hotkey] of Object.entries(raw)) {
    if (!isMenuCommandId(id) || typeof hotkey !== 'string' || hotkey.length === 0 || hotkey.length > MENU_HOTKEY_MAX) continue;
    next.set(id, hotkey);
  }
  const changed = next.size !== current.size || [...next].some(([id, hotkey]) => current.get(id) !== hotkey);
  current = next;
  return changed;
}

/** 菜单命令当前显示的 accelerator(未推送 / 未绑定 / 无法表示 → undefined)。 */
export function menuAcceleratorOf(id: MenuCommandId, isMac: boolean = process.platform === 'darwin'): string | undefined {
  const hotkey = current.get(id);
  return hotkey === undefined ? undefined : hotkeyToAccelerator(hotkey, isMac);
}
