// 键盘事件 → 快捷键主键(录制 KeybindingCaptureModal.eventToCombo 与匹配 useCommandHotkeys 共用)。
//
// 对齐 VSCode:keybinding 记「基础键 + 修饰键」(`shift+/` 而非 `?`,mac ⌥K 是 `alt+k` 而非 `˚`)。VSCode 按 scanCode
// 经系统键盘布局推出基础键;这里不读系统布局,只在 e.key 已被修饰键「变形」时按 e.code 取 US 布局基础键,
// 其余仍用 e.key —— 非 US 布局下普通字母 / 布局字符(德语 ü、QWERTZ 的 z)不回归。
//
// BDD: src/__tests__/hotkey-physical-key/

import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';

/** e.code → US 布局基础键(VSCode 的 US 回退表同义)。 */
const US_CODE_KEYS: ReadonlyMap<string, string> = new Map([
  ...Array.from({ length: 26 }, (_, i): [string, string] => {
    const ch = String.fromCharCode(97 + i);
    return [`Key${ch.toUpperCase()}`, ch];
  }),
  ...Array.from({ length: 10 }, (_, i): [string, string] => [`Digit${i}`, String(i)]),
  ['Minus', '-'],
  ['Equal', '='],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Backslash', '\\'],
  ['Semicolon', ';'],
  ['Quote', "'"],
  ['Backquote', '`'],
  ['Comma', ','],
  ['Period', '.'],
  ['Slash', '/'],
]);

/** US 布局上档符号 → 同一物理键的基础键。 */
const US_SHIFTED_TO_BASE: ReadonlyMap<string, string> = new Map([
  ['!', '1'], ['@', '2'], ['#', '3'], ['$', '4'], ['%', '5'],
  ['^', '6'], ['&', '7'], ['*', '8'], ['(', '9'], [')', '0'],
  ['_', '-'], ['+', '='], ['{', '['], ['}', ']'], ['|', '\\'],
  [':', ';'], ['"', "'"], ['~', '`'], ['<', ','], ['>', '.'], ['?', '/'],
]);

/**
 * 含 shift 的快捷键主键归一:US 上档符号 → 基础键(`mod+shift+?` ≡ `mod+shift+/`)。旧版按 e.key 录下 / 手写的上档写法
 * 与现在录到的基础键写法在运行时匹配、冲突检测里视为同一个键。不含 shift 时原样返回。
 */
export function baseKeyForShifted(lowerKey: string, hasShift: boolean): string {
  return hasShift ? (US_SHIFTED_TO_BASE.get(lowerKey) ?? lowerKey) : lowerKey;
}

function isAsciiLetter(code: number): boolean {
  const lower = code | 32;
  return lower >= 97 && lower <= 122;
}

/**
 * 事件的主键若须按物理键取(⌥ / ⇧ 变形字符、死键),返回 e.code 推出的 US 基础键;否则 undefined(用 e.key 小写)。
 * 单独导出供热路径复用已算好的 e.key 小写(useCommandHotkeys 每次按键只小写一次)。
 */
export function physicalHotkeyKey(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'shiftKey'>,
): string | undefined {
  const key = e.key;
  const first = key.charCodeAt(0);
  let physical: boolean;
  if (key.length > 1 && first < 128) {
    // 命名键(Enter / ArrowUp / F6 …)原样;死键 / 无法识别 → 物理键。
    physical = key === 'Dead' || key === 'Unidentified';
  } else if (isAsciiLetter(first)) {
    physical = false;
  } else {
    // ⌥ 改写了字符(mac Option 层);⇧ + ASCII 数字 / 符号得到上档符号。无 ⌥ 的非 ASCII 字符是布局本身的字符,保留。
    physical = e.altKey || (e.shiftKey && first < 128);
  }
  return physical && typeof e.code === 'string' ? US_CODE_KEYS.get(e.code) : undefined;
}

/** 事件的快捷键主键(已小写)。 */
export function eventHotkeyKey(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'shiftKey'>,
): string {
  return physicalHotkeyKey(e) ?? lowerIfNeeded(e.key);
}
