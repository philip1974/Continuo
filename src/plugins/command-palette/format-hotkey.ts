// 命令 hotkey 显示格式化(platform-aware).
//
// 注册时仍用 `mod+x` 抽象形态(由 useCommandHotkeys 的 compileCombo 预编译后匹配,
// 跨平台同 raw)。本模块只管 UI 显示,把 raw 转成视觉友好的 string。
//
// mac:Unicode 紧凑形式 `⇧⌘H` / `⌘,`(修饰键固定 ⌃⌥⇧⌘ 顺序)
// other:文字 + 分隔形式 `Ctrl+Shift+H` / `Ctrl+,`(修饰键固定 Ctrl+Alt+Shift+Win 顺序)
//
// BDD: src/__tests__/format-hotkey/

import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';
import { ownValue } from '../../../electron/shared/own-value';
import { baseKeyForShifted } from './event-hotkey-key';

export type Platform = 'mac' | 'other';

const MOD_MAP: Record<Platform, Record<string, string>> = {
  mac: {
    mod: '⌘',
    cmd: '⌘',
    shift: '⇧',
    alt: '⌥',
    option: '⌥',
    ctrl: '⌃',
  },
  other: {
    mod: 'Ctrl',
    // 非 mac 上录制 Meta 键得到 'cmd'(见 KeybindingCaptureModal.eventToCombo)
    cmd: 'Win',
    shift: 'Shift',
    alt: 'Alt',
    option: 'Alt',
    ctrl: 'Ctrl',
  },
};

// 按规范名(真实 e.key 小写名)建表;别名经 canonicalHotkeyKey 归一后再查。
const SPECIAL_KEYS: Record<Platform, Record<string, string>> = {
  mac: {
    enter: '↵',
    escape: '⎋',
    space: '␣',
    tab: '⇥',
    backspace: '⌫',
    delete: '⌦',
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
    pageup: '⇞',
    pagedown: '⇟',
  },
  other: {
    enter: 'Enter',
    escape: 'Esc',
    space: 'Space',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Del',
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
    pageup: 'PageUp',
    pagedown: 'PageDown',
  },
};

/**
 * 主键别名 → 真实 `e.key` 小写名。录制产出的是 e.key 名(arrowup / escape / enter …),手写的快捷键常用
 * 别名(up / esc / return …)。匹配(useCommandHotkeys)与显示(formatPart)都先经此归一,三处同一套词汇。
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  // 旧浏览器的 e.key 'Spacebar';录制 / 匹配统一记 space(见 event-hotkey-key)。
  spacebar: 'space',
};

/** 把(已小写的)主键别名归一成 e.key 名;非别名原样返回。 */
export function canonicalHotkeyKey(lowerKey: string): string {
  return ownValue(KEY_ALIASES, lowerKey) ?? lowerKey;
}

/**
 * 运行时(useCommandHotkeys.compileCombo)认识的修饰键词汇(小写)。注册 / override 写读 / 捕获校验
 * 共用:未知修饰符(如 hyper)直接拒绝,否则 compileCombo 会把它静默忽略、降级成裸主键触发。
 */
const HOTKEY_MODIFIERS: ReadonlySet<string> = new Set([
  'mod',
  'cmd',
  'ctrl',
  'shift',
  'alt',
  'option',
]);

/** (已小写的)修饰键段是否在运行时词汇内。 */
export function isKnownHotkeyModifier(lowerModifier: string): boolean {
  return HOTKEY_MODIFIERS.has(lowerModifier);
}

// 修饰键的运行时语义位(compileCombo 同一映射):cmd / mac 上的 mod → meta;ctrl / 其它平台的 mod → ctrl;
// option≡alt。canonicalHotkey(冲突比较)与显示排序共用。
const MOD_META = 1;
const MOD_CTRL = 2;
const MOD_ALT = 4;
const MOD_SHIFT = 8;

/** (已小写、已 trim 的)修饰键段 → 语义位;未知修饰符 → 0。 */
function modifierBit(mod: string, platform: Platform): number {
  if (mod === 'cmd' || (mod === 'mod' && platform === 'mac')) return MOD_META;
  if (mod === 'ctrl' || mod === 'mod') return MOD_CTRL;
  if (mod === 'alt' || mod === 'option') return MOD_ALT;
  if (mod === 'shift') return MOD_SHIFT;
  return 0;
}

/**
 * 修饰键**显示**顺序(与注册段序无关,否则 `shift+mod+enter` 显示 ⇧⌘↵、`mod+shift+n` 显示 ⌘⇧N):
 * mac ⌃⌥⇧⌘(Apple HIG / VSCode mac 同序);其它 Ctrl+Alt+Shift+Win。
 */
const MOD_DISPLAY_ORDER = [MOD_CTRL, MOD_ALT, MOD_SHIFT, MOD_META] as const;
const MOD_DISPLAY_LABEL: Record<Platform, Readonly<Record<number, string>>> = {
  mac: { [MOD_CTRL]: '⌃', [MOD_ALT]: '⌥', [MOD_SHIFT]: '⇧', [MOD_META]: '⌘' },
  other: { [MOD_CTRL]: 'Ctrl', [MOD_ALT]: 'Alt', [MOD_SHIFT]: 'Shift', [MOD_META]: 'Win' },
};

/**
 * 把整串快捷键归一成「运行时语义」签名,用于比较两个快捷键是否会被同一次按键触发:
 * - 主键别名归一(`mod+up` ≡ 录制出的 `mod+arrowup`)
 * - 修饰键去重、大小写不敏感、按固定顺序输出(`shift+mod+enter` ≡ `mod+shift+enter`)
 * - 修饰键别名按 compileCombo 同一映射:option≡alt;mod 在 mac≡cmd(metaKey)、其它平台≡ctrl
 * - 含 shift 时 US 上档符号归一到基础键(`mod+shift+?` ≡ `mod+shift+/`,与 compileCombo 同一归一)
 * 含未知修饰符的串运行时不可匹配,原样返回(只与完全相同的串相等)。
 */
export function canonicalHotkey(combo: string, platform: Platform): string {
  const sig = hotkeySignature(combo, platform);
  if (sig === null) return combo;
  const { mask, key } = sig;
  return (
    (mask & MOD_META ? 'meta+' : '') +
    (mask & MOD_CTRL ? 'ctrl+' : '') +
    (mask & MOD_ALT ? 'alt+' : '') +
    (mask & MOD_SHIFT ? 'shift+' : '') +
    key
  );
}

/** 快捷键的运行时语义:修饰键位掩码 + 归一后的主键。 */
export interface HotkeySignature {
  readonly mask: number;
  readonly key: string;
}

/** 整串快捷键 → 运行时语义(归一规则见 canonicalHotkey);含未知修饰符 → null。 */
export function hotkeySignature(combo: string, platform: Platform): HotkeySignature | null {
  let mask = 0;
  let start = 0;
  for (;;) {
    const plus = combo.indexOf('+', start);
    if (plus < 0) break;
    const bit = modifierBit(lowerIfNeeded(combo.slice(start, plus).trim()), platform);
    if (bit === 0) return null;
    mask |= bit;
    start = plus + 1;
  }
  const key = baseKeyForShifted(
    canonicalHotkeyKey(lowerIfNeeded(combo.slice(start).trim())),
    (mask & MOD_SHIFT) !== 0,
  );
  return { mask, key };
}

/**
 * 快捷键的「修饰键固定顺序英文名」(非 mac ctrl+shift+t;mac cmd+shift+t / option+…)。设置 › 快捷键的搜索文本含它,
 * 按快捷键过滤列表(录键弹窗点冲突项)也用它作搜索串 —— 与注册串的段序 / 别名无关。
 */
export function hotkeyFilterQuery(hotkey: string, platform: Platform): string {
  const named = canonicalHotkey(hotkey, platform);
  return platform === 'mac' ? named.replace('meta+', 'cmd+').replace('alt+', 'option+') : named;
}

const EMPTY_HOTKEY_PARTS: string[] = [];

/** numpad1 → NumPad1;numpad_multiply → NumPad_Multiply(VSCode keyCodes 的 uiLabel)。 */
function numpadLabel(lower: string): string {
  const rest = lower.slice('numpad'.length);
  return rest.startsWith('_') && rest.length > 1
    ? `NumPad_${rest.charAt(1).toUpperCase()}${rest.slice(2)}`
    : `NumPad${rest}`;
}

function formatPart(part: string, platform: Platform): string {
  const lower = lowerIfNeeded(part);
  // 主键名来自插件 hotkey:只认自有属性(constructor 等不得命中原型链返回函数)。
  const mod = ownValue(MOD_MAP[platform], lower);
  if (mod) return mod;
  const special = ownValue(SPECIAL_KEYS[platform], canonicalHotkeyKey(lower));
  if (special) return special;
  // 小键盘键:VSCode 的 UI 标签(NumPad1 / NumPad_Multiply),与主键盘 1 / * 区分。
  if (lower.startsWith('numpad')) return numpadLabel(lower);
  // 普通字母 / 数字 / 符号 → uppercase(F1 / A / , / .)
  return part.toUpperCase();
}

/** 按 `+` 切分 raw,对每个**非空**段回调其 [start, end) 下标(不分配子串;空段如 `a++b` 跳过)。 */
function forEachHotkeySegment(
  raw: string,
  visit: (start: number, end: number) => void,
): void {
  let start = 0;
  for (;;) {
    const plus = raw.indexOf('+', start);
    const end = plus < 0 ? raw.length : plus;
    if (end > start) visit(start, end);
    if (plus < 0) return;
    start = plus + 1;
  }
}

/**
 * 修饰段(除最后一段外的非空段)的语义位掩码与主键段位置。任一修饰段不认识 → mask = -1(调用方按原段序显示,
 * 不猜测其位置)。空 raw → keyStart = -1。
 */
function parseForDisplay(
  raw: string,
  platform: Platform,
): { readonly mask: number; readonly keyStart: number; readonly keyEnd: number } {
  let mask = 0;
  let keyStart = -1;
  let keyEnd = -1;
  forEachHotkeySegment(raw, (start, end) => {
    if (keyStart >= 0 && mask >= 0) {
      const bit = modifierBit(lowerIfNeeded(raw.slice(keyStart, keyEnd)), platform);
      mask = bit === 0 ? -1 : mask | bit;
    }
    keyStart = start;
    keyEnd = end;
  });
  return { mask, keyStart, keyEnd };
}

/**
 * 拆 raw 为 platform-aware 的 parts 数组。给 KeyCap 渲染用(每个 part
 * 一个 keycap)。修饰键按固定顺序输出(见 MOD_DISPLAY_ORDER),同义修饰键去重。
 * 例:`mod+shift+h` / `shift+mod+h` mac → ['⇧','⌘','H'];other → ['Ctrl','Shift','H']。
 * 含未知修饰段时按原段序逐段格式化。
 *
 * 空字符串 / 全 + → 空数组(调用方判空)。
 */
export function formatHotkeyParts(
  raw: string,
  platform: Platform,
): string[] {
  const { mask, keyStart, keyEnd } = parseForDisplay(raw, platform);
  if (keyStart < 0) return EMPTY_HOTKEY_PARTS;
  if (mask < 0) return formatSegmentsInOrder(raw, platform);
  let count = 1;
  for (const bit of MOD_DISPLAY_ORDER) if (mask & bit) count += 1;
  const parts = new Array<string>(count);
  let index = 0;
  for (const bit of MOD_DISPLAY_ORDER) {
    if (mask & bit) parts[index++] = MOD_DISPLAY_LABEL[platform][bit]!;
  }
  parts[index] = formatPart(raw.slice(keyStart, keyEnd), platform);
  return parts;
}

/** 按注册段序逐段格式化(含未知修饰段时的回退)。 */
function formatSegmentsInOrder(raw: string, platform: Platform): string[] {
  // 两趟:先数段数再按确切长度预分配。两趟共用同一个切分器。
  let count = 0;
  forEachHotkeySegment(raw, () => {
    count += 1;
  });
  const parts = new Array<string>(count);
  let index = 0;
  forEachHotkeySegment(raw, (start, end) => {
    parts[index] = formatPart(raw.slice(start, end), platform);
    index += 1;
  });
  return parts;
}

/** 字符串形式:mac 紧贴(⇧⌘H),其它 `+` 分隔(Ctrl+Shift+H)。与 formatHotkeyParts 同序。 */
export function formatHotkey(raw: string, platform: Platform): string {
  const parts = formatHotkeyParts(raw, platform);
  let formatted = '';
  for (let i = 0; i < parts.length; i += 1) {
    if (platform !== 'mac' && i > 0) formatted += '+';
    formatted += parts[i];
  }
  return formatted;
}

function containsApplePlatformToken(value: string): boolean {
  return (
    value.includes('Mac') ||
    value.includes('iPhone') ||
    value.includes('iPad') ||
    value.includes('iPod')
  );
}

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  // navigator.platform 有的浏览器已 deprecate,但 Electron 永远填值
  // (Mac/MacIntel/MacPPC 等 Mac 字段)。userAgent 兜底。
  const platform =
    typeof navigator.platform === 'string' ? navigator.platform : '';
  const ua = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
  if (containsApplePlatformToken(platform)) return 'mac';
  if (containsApplePlatformToken(ua)) return 'mac';
  return 'other';
}
