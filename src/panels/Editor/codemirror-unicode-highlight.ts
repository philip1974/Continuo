// 编辑器里的不可见 / 双向控制字符与同形字(对齐 VSCode editor.renderControlCharacters 与 editor.unicodeHighlight.*):
// 打开不可信项目时,`‮` 之类会让显示顺序与真实内容不符(Trojan Source),零宽字符让两个不同的标识符看起来一样,
// 西里尔字母 а 冒充 ASCII a。
//
// - 不可见 / 控制字符:CodeMirror basicSetup 的 highlightSpecialChars 默认集合漏了 VSCode 视为控制字符的 U+202A–202C、U+2068,
//   与 VSCode InvisibleCharacters 里的大部分(U+2060–206F、各种宽度的空格 U+2000–200A、填充符、tag 字符 …)→ addSpecialChars 补上
//   (显示成红点占位,悬停给出码位;只改显示,不改内容)。代码与 Markdown 源码都生效。
//   刻意不补(避免破坏正常文字的显示):ZWNJ / ZWJ(U+200C / 200D:emoji 组合、波斯文 / 印地文)、变体选择符(U+FE00–FE0F、
//   U+E0100–E01EF:emoji 呈现、汉字异体)、不换行空格 U+00A0 与全角空格 U+3000(中日文常用)—— VSCode 把它们也画框,
//   但 CodeMirror 的占位会替换掉字符本身。
// - 同形字(VSCode unicodeHighlight.ambiguousCharacters,默认开;Markdown / 纯文本默认关,同 VSCode 的
//   [markdown] / [plaintext] 语言默认值):易与 ASCII 混淆的非 ASCII 字符加框,悬停说明「可能与 ASCII 字符 x 混淆」。数据取自
//   VSCode(见 unicode-ambiguous-data),按界面语言选集合(VSCode allowedLocales 的 _vscode);规则同 VSCode
//   CodePointHighlighter:所在「词」里没有 ASCII、又有明显的非 ASCII 字符(如中文)时不标(整段外文不被刷满框)。
//   只装饰可视范围(MatchDecorator)。注释里同样标(相当于 VSCode 未信任工作区的 includeComments)。
// BDD: src/__tests__/editor-unicode-highlight/

import { language } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  highlightSpecialChars,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { getLocale, t } from '@/i18n';
import type { Locale } from '../../../electron/shared/i18n-types';
import { AMBIGUOUS_CHARACTER_DATA } from './unicode-ambiguous-data';

const EXTRA_SPECIAL_RANGES: readonly (readonly [number, number])[] = [
  [0x034f, 0x034f], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180e], [0x1cbb, 0x1cbc], [0x2000, 0x200a],
  [0x202a, 0x202c], [0x202f, 0x202f], [0x205f, 0x205f], [0x2060, 0x2065], [0x2068, 0x2068], [0x206a, 0x206f],
  [0x2800, 0x2800], [0x3164, 0x3164], [0xffa0, 0xffa0], [0xfff0, 0xfff8], [0x133fc, 0x133fc], [0x1d173, 0x1d17a],
  [0xe0000, 0xe007f],
];
const hexEscape = (cp: number): string => `\\u{${cp.toString(16)}}`;
/** 补进 highlightSpecialChars 的字符(CodeMirror 默认集合之外;来源与刻意排除见文件头)。由码位区间生成(其中有组合字符,写成字面量正则会被误读)。 */
export const EXTRA_SPECIAL_CHARS = new RegExp(
  `[${EXTRA_SPECIAL_RANGES.map(([lo, hi]) => (lo === hi ? hexEscape(lo) : `${hexEscape(lo)}-${hexEscape(hi)}`)).join('')}]`,
  'u',
);

const LOCALE_SET: Readonly<Record<Locale, keyof typeof AMBIGUOUS_CHARACTER_DATA>> = {
  en: '_default',
  zh: 'zh-hans',
  ko: 'ko',
};

const mapCache = new Map<Locale, ReadonlyMap<number, number>>();

/** 码位 → 易混的 ASCII 码位:_common + 界面语言对应的集合(VSCode AmbiguousCharacters.getInstance)。 */
export function ambiguousCharacters(locale: Locale): ReadonlyMap<number, number> {
  let m = mapCache.get(locale);
  if (!m) {
    const map = new Map<number, number>();
    for (const arr of [AMBIGUOUS_CHARACTER_DATA._common, AMBIGUOUS_CHARACTER_DATA[LOCALE_SET[locale]]]) {
      for (let i = 0; i + 1 < arr.length; i += 2) map.set(arr[i]!, arr[i + 1]!);
    }
    m = map;
    mapCache.set(locale, m);
  }
  return m;
}

/** VSCode DEFAULT_WORD_REGEXP 的分隔符(ASCII 标点与空白):「词」= 不含它们的最长连续串。 */
const WORD_SEPARATOR = /[`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]/u;

const isBasicAscii = (cp: number): boolean => cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0x7e);

/**
 * VSCode CodePointHighlighter.shouldHighlightNonBasicASCII 的同形字部分:字符所在的词里没有 ASCII、却有明显不像 ASCII 的
 * 非 ASCII 字符(既非同形字)→ 不标。line = 所在行文本,index = 字符在行内的 UTF-16 偏移。
 */
export function shouldHighlightAmbiguous(line: string, index: number, map: ReadonlyMap<number, number>): boolean {
  // 分隔符都在 BMP 内(ASCII 标点与空白),按 UTF-16 码元扫即可:代理对的两半都不是分隔符
  let start = index;
  while (start > 0 && !WORD_SEPARATOR.test(line[start - 1]!)) start--;
  let end = index + 1;
  while (end < line.length && !WORD_SEPARATOR.test(line[end]!)) end++;
  let hasAscii = false;
  let hasObviousNonAscii = false;
  for (const ch of line.slice(start, end)) {
    const cp = ch.codePointAt(0)!;
    if (isBasicAscii(cp)) hasAscii = true;
    else if (!map.has(cp)) hasObviousNonAscii = true;
  }
  return hasAscii || !hasObviousNonAscii;
}

const pretty = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')} "${String.fromCodePoint(cp)}"`;

function ambiguousDecorator(locale: Locale): MatchDecorator {
  const map = ambiguousCharacters(locale);
  const cls = [...map.keys()].map((cp) => `\\u{${cp.toString(16)}}`).join('');
  const marks = new Map<number, Decoration>();
  return new MatchDecorator({
    regexp: new RegExp(`[${cls}]`, 'gu'),
    decoration: (m, view, pos) => {
      const line = view.state.doc.lineAt(pos);
      if (!shouldHighlightAmbiguous(line.text, pos - line.from, map)) return null;
      const cp = m[0].codePointAt(0)!;
      let deco = marks.get(cp);
      if (!deco) {
        const title = t('panels.editor.unicode.ambiguous', { char: pretty(cp), ascii: pretty(map.get(cp)!) });
        deco = Decoration.mark({ class: 'cm-ambiguousChar', attributes: { title } });
        marks.set(cp, deco);
      }
      return deco;
    },
  });
}

/** Markdown 与纯文本(无语言)不标同形字(VSCode [markdown] / [plaintext] 的语言默认值)。 */
function ambiguousEnabled(view: EditorView): boolean {
  const lang = view.state.facet(language);
  return lang !== null && lang.name !== 'markdown';
}

const ambiguousPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private readonly decorator: MatchDecorator;
    private enabled: boolean;
    constructor(view: EditorView) {
      this.decorator = ambiguousDecorator(getLocale());
      this.enabled = ambiguousEnabled(view);
      this.decorations = this.enabled ? this.decorator.createDeco(view) : Decoration.none;
    }
    update(update: ViewUpdate) {
      const enabled = ambiguousEnabled(update.view);
      if (!enabled) this.decorations = Decoration.none;
      else if (!this.enabled || update.startState.facet(language) !== update.state.facet(language)) {
        this.decorations = this.decorator.createDeco(update.view);
      } else this.decorations = this.decorator.updateDeco(update, this.decorations);
      this.enabled = enabled;
    }
  },
  { decorations: (v) => v.decorations },
);

/** 同形字的框(VSCode editorUnicodeHighlight.border = editorWarning.foreground → --md-warning;强制颜色下用系统文字色)。 */
const ambiguousTheme = EditorView.baseTheme({
  '.cm-ambiguousChar': {
    outline: '1px solid var(--md-warning)',
    outlineOffset: '-1px',
    borderRadius: '2px',
  },
  '@media (forced-colors: active)': { '.cm-ambiguousChar': { outline: '1px solid CanvasText' } },
});

export const unicodeHighlight: Extension = [
  highlightSpecialChars({ addSpecialChars: EXTRA_SPECIAL_CHARS }),
  ambiguousPlugin,
  ambiguousTheme,
];
