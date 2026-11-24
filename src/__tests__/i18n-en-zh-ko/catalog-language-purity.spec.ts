// @vitest-environment node
// 文案语言纯净:zh / ko 界面文案不夹带可翻译的英文 UI 词(「切换 Settings」「Explorer 숨기기」),en 不夹带中文 / 韩文。
// 判断标准对齐 VSCode 中文 / 韩文版:VSCode 本地化版本会翻译的词(Settings / Explorer / Editor / Panel / Status Bar /
// Terminal / Workspace / Tab / Tag / Review / Hotkey…)必须翻;专有名词与产品名(Markdown / Git / GitHub / MCP /
// Mermaid / Milkdown / Finder / Agent / shell / URL / API / Node.js…)与代码标识(export default /
// sessionId / GITHUB_TOKEN / PermissionError)可保留。
import { describe, expect, it } from 'vitest';
import { en } from '../../../electron/shared/i18n-locales/en';
import { ko } from '../../../electron/shared/i18n-locales/ko';
import { zh } from '../../../electron/shared/i18n-locales/zh';

/** VSCode 中文 / 韩文版会翻译的英文 UI 词(按词边界、大小写不敏感)。 */
const TRANSLATABLE_UI_WORDS = [
  'Settings',
  'Explorer',
  'Editor',
  'CodeEditor',
  'Panel',
  'StatusBar',
  'Status Bar',
  'Ribbon',
  'Editor Action',
  'Tab',
  'tag',
  'review',
  'hotkey',
  'terminal',
  'workspace',
  'plugin',
  'plugin manager',
  'token',
  'cwd',
  'xterm',
  'fit',
  'marker',
  'system',
  'Source',
  'Edit',
] as const;

const WORD_RE = new RegExp(`(?<![A-Za-z_.])(?:${TRANSLATABLE_UI_WORDS.map((w) => w.replace(/ /g, '\\s')).join('|')})(?![A-Za-z_])`, 'i');

/** 代码标识 / 类名原样出现的短语(不是 UI 词):检查前剔除。 */
const CODE_PHRASES = [/\bPlugin (?=子类|하위)/g, /\bdefault export\b/g];

function leaks(catalog: Record<string, string>): string[] {
  return Object.entries(catalog)
    .map(([key, value]) => [key, CODE_PHRASES.reduce((v, re) => v.replace(re, ''), value.replace(/\{[^}]*\}/g, ''))] as const)
    .filter(([, value]) => WORD_RE.test(value))
    .map(([key, value]) => `${key}: ${value}`);
}

describe('i18n 文案语言纯净', () => {
  it('zh 文案不夹带可翻译的英文 UI 词', () => {
    expect(leaks(zh)).toEqual([]);
  });

  it('ko 文案不夹带可翻译的英文 UI 词', () => {
    expect(leaks(ko)).toEqual([]);
  });

  it('en 文案不含中文 / 韩文字符', () => {
    const cjk = Object.entries(en)
      .filter(([, value]) => /[　-〿㐀-鿿가-힯＀-￯]/.test(value))
      .map(([key, value]) => `${key}: ${value}`);
    expect(cjk).toEqual([]);
  });

  it('点名回归:zh「切换设置」「切换资源管理器侧栏」「在命令面板中搜索执行」', () => {
    expect(zh['commands.settings.toggle.title']).toBe('切换设置');
    expect(zh['settings.explorer.toggle_sidebar']).toBe('切换资源管理器侧栏');
    expect(zh['keybindings.palette_hint_suffix']).toContain('命令面板');
  });
});
