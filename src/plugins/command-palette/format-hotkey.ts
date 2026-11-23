// 命令 hotkey 显示格式化(platform-aware).
//
// 注册时仍用 `mod+x` 抽象形态(由 useCommandHotkeys 的 compileCombo 预编译后匹配,
// 跨平台同 raw)。本模块只管 UI 显示,把 raw 转成视觉友好的 string。
//
// mac:Unicode 紧凑形式 `⌘⇧H` / `⌘,`
// other:文字 + 分隔形式 `Ctrl+Shift+H` / `Ctrl+,`
//
// BDD: src/__tests__/format-hotkey/

import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';
import { ownValue } from '../../../electron/shared/own-value';

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

/**
 * 把整串快捷键归一成「运行时语义」签名,用于比较两个快捷键是否会被同一次按键触发:
 * - 主键别名归一(`mod+up` ≡ 录制出的 `mod+arrowup`)
 * - 修饰键去重、大小写不敏感、按固定顺序输出(`shift+mod+enter` ≡ `mod+shift+enter`)
 * - 修饰键别名按 compileCombo 同一映射:option≡alt;mod 在 mac≡cmd(metaKey)、其它平台≡ctrl
 * 含未知修饰符的串运行时不可匹配,原样返回(只与完全相同的串相等)。
 */
export function canonicalHotkey(combo: string, platform: Platform): string {
  let meta = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let start = 0;
  for (;;) {
    const plus = combo.indexOf('+', start);
    if (plus < 0) break;
    const mod = lowerIfNeeded(combo.slice(start, plus).trim());
    if (mod === 'cmd' || (mod === 'mod' && platform === 'mac')) meta = true;
    else if (mod === 'ctrl' || mod === 'mod') ctrl = true;
    else if (mod === 'alt' || mod === 'option') alt = true;
    else if (mod === 'shift') shift = true;
    else return combo;
    start = plus + 1;
  }
  const key = canonicalHotkeyKey(lowerIfNeeded(combo.slice(start).trim()));
  return (
    (meta ? 'meta+' : '') +
    (ctrl ? 'ctrl+' : '') +
    (alt ? 'alt+' : '') +
    (shift ? 'shift+' : '') +
    key
  );
}

const EMPTY_HOTKEY_PARTS: string[] = [];

function formatPart(part: string, platform: Platform): string {
  const lower = lowerIfNeeded(part);
  // 主键名来自插件 hotkey:只认自有属性(constructor 等不得命中原型链返回函数)。
  const mod = ownValue(MOD_MAP[platform], lower);
  if (mod) return mod;
  const special = ownValue(SPECIAL_KEYS[platform], canonicalHotkeyKey(lower));
  if (special) return special;
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
 * 拆 raw 为 platform-aware 的 parts 数组。给 KeyCap 渲染用(每个 part
 * 一个 keycap)。例:`mod+shift+h` mac → ['⌘','⇧','H'];other →
 * ['Ctrl','Shift','H']。
 *
 * 空字符串 / 全 + → 空数组(调用方判空)。
 */
export function formatHotkeyParts(
  raw: string,
  platform: Platform,
): string[] {
  // 两趟:先数段数再按确切长度预分配(每次按键渲染都会走,避免数组扩容)。两趟共用同一个切分器。
  let count = 0;
  forEachHotkeySegment(raw, () => {
    count += 1;
  });
  if (count === 0) return EMPTY_HOTKEY_PARTS;
  const parts = new Array<string>(count);
  let index = 0;
  forEachHotkeySegment(raw, (start, end) => {
    parts[index] = formatPart(raw.slice(start, end), platform);
    index += 1;
  });
  return parts;
}

export function formatHotkey(raw: string, platform: Platform): string {
  let formatted = '';
  let needsSeparator = false;
  forEachHotkeySegment(raw, (start, end) => {
    const part = formatPart(raw.slice(start, end), platform);
    if (platform !== 'mac' && needsSeparator) formatted += '+';
    formatted += part;
    needsSeparator = true;
  });
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
