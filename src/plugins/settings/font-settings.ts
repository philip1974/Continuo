// 字体族 / 行高设置的取值规则(VSCode editor.fontFamily / editor.lineHeight / terminal.integrated.fontFamily /
// terminal.integrated.lineHeight)。纯函数:设置值(可能来自篡改 / 旧版存储)→ 实际用的 CSS 字体串 / 行高。
// BDD: src/__tests__/font-settings/

import {
  DEFAULT_EDITOR_FONT_FAMILY,
  EDITOR_LINE_HEIGHT,
  TERMINAL_LINE_HEIGHT,
} from './core-setting-specs';

/**
 * 终端自带字体链(未设置终端字体、编辑器字体也是默认值时):随应用打包的 MesloLGS NF 优先,其余 Nerd Font / Powerline 字体
 * 兜 P10k / oh-my-zsh 的图标字形,再到系统等宽。
 */
export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"MesloLGS NF", "JetBrainsMono Nerd Font Mono", "Symbols Nerd Font Mono", "Meslo LG M for Powerline", "Meslo LG L for Powerline", "Meslo LG S for Powerline", "SF Mono", Menlo, Monaco, Consolas, monospace';

/** 用户指定终端字体时接在后面的回退:Nerd Font 符号(用户字体缺 Powerline 字形时)+ monospace(VSCode 总接 monospace)。 */
const TERMINAL_SYMBOL_FALLBACK = '"MesloLGS NF", "Symbols Nerd Font Mono", monospace';

/** 去掉首尾空白与结尾多余的逗号;只剩空 → ''。 */
function cleanFontFamily(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[\s,]+$/, '');
}

/** editor.fontFamily → 编辑器字体串(空 / 全空白 / 非字符串 → 默认)。 */
export function resolveEditorFontFamily(value: unknown): string {
  return cleanFontFamily(value) || DEFAULT_EDITOR_FONT_FAMILY;
}

/**
 * terminal.integrated.fontFamily(空 → editor.fontFamily)→ xterm fontFamily。两者都未自定义(空 / 等于编辑器默认)→ 终端
 * 自带字体链;否则用户字体 + 符号回退。
 */
export function resolveTerminalFontFamily(terminalValue: unknown, editorValue: unknown): string {
  const own = cleanFontFamily(terminalValue);
  const editor = cleanFontFamily(editorValue);
  const user = own || (editor === DEFAULT_EDITOR_FONT_FAMILY ? '' : editor);
  return user ? `${user}, ${TERMINAL_SYMBOL_FALLBACK}` : DEFAULT_TERMINAL_FONT_FAMILY;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** VSCode fontInfo:行高不低于 8px。 */
const MINIMUM_EDITOR_LINE_HEIGHT = 8;

/**
 * editor.lineHeight + editor.fontSize → 行高像素;0(自动)→ null(用编辑器默认行高)。0 < v < 8 为字号倍数,≥ 8 为像素;
 * 先夹到 [0, 150],结果取整且不低于 8(VSCode 同)。
 */
export function resolveEditorLineHeightPx(value: unknown, fontSize: number): number | null {
  const v = Math.min(EDITOR_LINE_HEIGHT.max!, Math.max(EDITOR_LINE_HEIGHT.min!, finiteOr(value, 0)));
  if (v === 0) return null;
  const px = Math.round(v < MINIMUM_EDITOR_LINE_HEIGHT ? v * fontSize : v);
  return Math.max(MINIMUM_EDITOR_LINE_HEIGHT, px);
}

/** terminal.integrated.lineHeight → xterm lineHeight(倍数):非有限 / 0 → 默认 1;夹到 [1, 10]。 */
export function resolveTerminalLineHeight(value: unknown): number {
  const v = finiteOr(value, 0);
  if (v === 0) return TERMINAL_LINE_HEIGHT.default;
  return Math.min(TERMINAL_LINE_HEIGHT.max!, Math.max(TERMINAL_LINE_HEIGHT.min!, v));
}
