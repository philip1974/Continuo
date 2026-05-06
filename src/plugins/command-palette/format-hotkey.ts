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

function formatPart(part: string, platform: Platform): string {
  const lower = part.toLowerCase();
  const mod = MOD_MAP[platform][lower];
  if (mod) return mod;
  const special = SPECIAL_KEYS[platform][lower];
  if (special) return special;
  // 普通字母 / 数字 / 符号 → uppercase(F1 / A / , / .)
  return part.toUpperCase();
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
  if (!raw) return [];
  return raw
    .split('+')
    .filter((p) => p.length > 0)
    .map((p) => formatPart(p, platform));
}

export function formatHotkey(raw: string, platform: Platform): string {
  const parts = formatHotkeyParts(raw, platform);
  if (parts.length === 0) return '';
  // mac 紧贴拼接,other 用 + 分隔
  return platform === 'mac' ? parts.join('') : parts.join('+');
}

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  // navigator.platform 有的浏览器已 deprecate,但 Electron 永远填值
  // (Mac/MacIntel/MacPPC 等 Mac 字段)。userAgent 兜底。
  const platform =
    typeof navigator.platform === 'string' ? navigator.platform : '';
  const ua = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
  if (/Mac|iPhone|iPad|iPod/.test(platform)) return 'mac';
  if (/Mac|iPhone|iPad|iPod/.test(ua)) return 'mac';
  return 'other';
}
