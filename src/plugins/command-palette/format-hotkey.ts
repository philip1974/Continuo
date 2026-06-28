// 命令 hotkey 显示格式化(platform-aware).
//
// 注册时仍用 `mod+x` 抽象形态(由 useCommandHotkeys.matchesHotkey 解析,
// 跨平台同 raw)。本模块只管 UI 显示,把 raw 转成视觉友好的 string。
//
// mac:Unicode 紧凑形式 `⌘⇧H` / `⌘,`
// other:文字 + 分隔形式 `Ctrl+Shift+H` / `Ctrl+,`
//
// BDD: src/__tests__/format-hotkey/

export type Platform = 'mac' | 'other';

const MOD_MAP: Record<Platform, Record<string, string>> = {
  mac: {
    mod: '⌘',
    shift: '⇧',
    alt: '⌥',
    option: '⌥',
    ctrl: '⌃',
  },
  other: {
    mod: 'Ctrl',
    shift: 'Shift',
    alt: 'Alt',
    option: 'Alt',
    ctrl: 'Ctrl',
  },
};

const SPECIAL_KEYS: Record<Platform, Record<string, string>> = {
  mac: {
    enter: '↵',
    return: '↵',
    escape: '⎋',
    esc: '⎋',
    space: '␣',
    tab: '⇥',
    backspace: '⌫',
    delete: '⌦',
    del: '⌦',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
  },
  other: {
    enter: 'Enter',
    return: 'Enter',
    escape: 'Esc',
    esc: 'Esc',
    space: 'Space',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Del',
    del: 'Del',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
  },
};

const EMPTY_HOTKEY_PARTS: string[] = [];

function lowerIfNeeded(value: string): string {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code >= 65 && code <= 90) || code > 127) {
      return value.toLowerCase();
    }
  }
  return value;
}

function formatPart(part: string, platform: Platform): string {
  const lower = lowerIfNeeded(part);
  const mod = MOD_MAP[platform][lower];
  if (mod) return mod;
  const special = SPECIAL_KEYS[platform][lower];
  if (special) return special;
  // 普通字母 / 数字 / 符号 → uppercase(F1 / A / , / .)
  return part.toUpperCase();
}

function visitFormattedHotkeyParts(
  raw: string,
  platform: Platform,
  visit: (part: string) => void,
): void {
  if (!raw) return;
  let start = 0;
  for (;;) {
    const plus = raw.indexOf('+', start);
    const end = plus < 0 ? raw.length : plus;
    if (end > start) {
      visit(formatPart(raw.slice(start, end), platform));
    }
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
  if (!raw) return EMPTY_HOTKEY_PARTS;
  let count = 0;
  let start = 0;
  for (;;) {
    const plus = raw.indexOf('+', start);
    const end = plus < 0 ? raw.length : plus;
    if (end > start) count += 1;
    if (plus < 0) break;
    start = plus + 1;
  }
  if (count === 0) return EMPTY_HOTKEY_PARTS;
  const parts = new Array<string>(count);
  let index = 0;
  start = 0;
  for (;;) {
    const plus = raw.indexOf('+', start);
    const end = plus < 0 ? raw.length : plus;
    if (end > start) {
      parts[index] = formatPart(raw.slice(start, end), platform);
      index += 1;
    }
    if (plus < 0) break;
    start = plus + 1;
  }
  return parts;
}

export function formatHotkey(raw: string, platform: Platform): string {
  let formatted = '';
  let needsSeparator = false;
  visitFormattedHotkeyParts(raw, platform, (part) => {
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
