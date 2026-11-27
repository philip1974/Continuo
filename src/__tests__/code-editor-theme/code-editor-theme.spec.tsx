// @vitest-environment jsdom
// 代码编辑器(CodeEditor:代码文件 + Markdown Source 模式)的外观与 Markdown frontmatter 解析。
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, highlightingFor } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { CodeEditor, pickLanguage } from '../../panels/Editor/CodeEditor';
import { markdownCodeBlockTheme } from '../../panels/Editor/code-editor-theme';
import { ThemeContext } from '../../theme/ThemeProvider';

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

function nodeNames(doc: string, lang = pickLanguage('README.md', 'markdown')): string[] {
  const state = EditorState.create({ doc, extensions: [lang] });
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  const names: string[] = [];
  tree?.iterate({ enter: (n) => void names.push(n.name) });
  return names;
}

/** 当前文档里 CodeMirror 注入的全部样式文本(StyleModule 挂在 adoptedStyleSheets 或 <style>)。 */
function injectedCss(): string {
  const fromTags = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
  const adopted = (document.adoptedStyleSheets ?? [])
    .flatMap((sheet) => [...sheet.cssRules].map((r) => r.cssText))
    .join('\n');
  return `${fromTags}\n${adopted}`;
}

async function mount(theme: 'dark' | 'light', fileName = 'a.ts', value = 'const a = 1;\n') {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  const utils = render(
    <ThemeContext.Provider value={{ mode: theme, resolved: theme, setMode: () => {} }}>
      <CodeEditor tabId={`/${fileName}`} value={value} fileName={fileName} />
    </ThemeContext.Provider>,
  );
  await act(async () => {});
  const el = utils.container.querySelector<HTMLElement>('.cm-editor');
  if (!el) throw new Error('no .cm-editor');
  return EditorView.findFromDOM(el)!;
}

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('dark');
});

describe('Markdown Source:YAML frontmatter', () => {
  it('文首 --- 包起来的 frontmatter 按 YAML 解析,不被当成 Setext 标题', () => {
    const names = nodeNames('---\ntitle: Test\ntags: [a, b]\n---\n\n# Heading\n\nbody\n');
    expect(names).not.toContain('SetextHeading2');
    expect(names).toContain('ATXHeading1');
    // YAML 键值对确实按 YAML 语法解析
    expect(names.some((n) => n === 'Pair' || n === 'Key')).toBe(true);
  });

  it('.md 文件名推断出的语言同样识别 frontmatter;没有 frontmatter 的文档照常解析', () => {
    expect(nodeNames('---\ntitle: T\n---\n', pickLanguage('notes.md'))).not.toContain('SetextHeading2');
    expect(nodeNames('Title\n---\n\ntext\n')).toContain('SetextHeading2');
  });
});

describe('CodeEditor 主题接设计 token', () => {
  it.each(['dark', 'light'] as const)('%s:背景 / gutter / 字体取自 --md-* / 编辑器字体变量(缺省 --wm-font-mono),不带 oneDark 固定底色', async (theme) => {
    await mount(theme);
    const css = injectedCss();
    expect(css).toMatch(/background(-color)?:\s*var\(--md-surface\)/);
    expect(css).toContain('var(--wm-editor-font-family, var(--wm-font-mono))');
    expect(css).toMatch(/\.cm-gutters[^}]*var\(--md-/);
    expect(css).not.toMatch(/#282c34/i);
  });

  it.each(['dark', 'light'] as const)('%s:聚焦时不画 CodeMirror 内置 1px dotted 轮廓(VSCode 编辑器聚焦无边框)', async (theme) => {
    await mount(theme);
    expect(injectedCss()).toMatch(/\.cm-focused\s*\{\s*outline:\s*none/);
  });

  it('暗色声明为 dark 主题,亮色不是(CodeMirror 内建样式按此选亮 / 暗变体)', async () => {
    expect((await mount('dark')).state.facet(EditorView.darkTheme)).toBe(true);
    cleanup();
    expect((await mount('light')).state.facet(EditorView.darkTheme)).toBe(false);
  });

  it('亮色有语法高亮且标题不加下划线', async () => {
    const light = await mount('light');
    expect(highlightingFor(light.state, [tags.keyword])).toBeTruthy();
    const headingClass = highlightingFor(light.state, [tags.heading]);
    expect(headingClass).toBeTruthy();
    const css = injectedCss();
    const rule = css.split('}').find((r) => headingClass!.split(' ').some((c) => r.includes(`.${c}`)));
    expect(rule ?? '').not.toContain('underline');
  });
});

// 语法色进 theme.css 自有槽位 --md-syntax-*(light / dark 各一套),HighlightStyle 只引用 var(--md-syntax-*):
// 一套高亮两主题通用,切主题靠 <html class="dark"> 即时生效;组件里不再有字面 hex。
describe('语法高亮走 --md-syntax-* token', () => {
  const read = (rel: string): string => readFileSync(join(__dirname, '..', '..', rel), 'utf-8');
  const block = (css: string, sel: ':root' | '.dark'): string =>
    css.match(new RegExp(`${sel === ':root' ? ':root' : '\\.dark'}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
  const slots = (b: string): Map<string, string> =>
    new Map([...b.matchAll(/(--md-syntax-[a-z-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1]!, m[2]!]));
  const lum = (h: string): number => {
    const [r, g, b] = [1, 3, 5]
      .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const themeCss = read('styles/theme.css');
  const tokensCss = read('styles/design-tokens.css');

  it('theme.css 的 :root 与 .dark 定义同一组 --md-syntax-* 槽位', () => {
    const light = slots(block(themeCss, ':root'));
    const dark = slots(block(themeCss, '.dark'));
    expect(light.size).toBeGreaterThanOrEqual(8);
    expect([...light.keys()].sort()).toEqual([...dark.keys()].sort());
  });

  it.each([':root', '.dark'] as const)('%s:每个语法色对编辑器底色(--md-surface)≥ 4.5', (sel) => {
    const surface = block(tokensCss, sel).match(/--md-surface:\s*(#[0-9a-f]{6});/i)?.[1] ?? '';
    expect(surface).not.toBe('');
    for (const [name, color] of slots(block(themeCss, sel))) {
      expect(contrast(color, surface), `${sel} ${name} ${color}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('暗色沿用 oneDark 配色(keyword 紫 #c678dd)', () => {
    expect(slots(block(themeCss, '.dark')).get('--md-syntax-keyword')?.toLowerCase()).toBe('#c678dd');
  });

  it('code-editor-theme.ts 不含字面 hex 色值,HighlightStyle 引用的槽位都在 theme.css 定义', () => {
    const src = read('panels/Editor/code-editor-theme.ts');
    expect(src).not.toMatch(/['"]#[0-9a-f]{3,8}['"]/i);
    const used = [...src.matchAll(/var\((--md-syntax-[a-z-]+)\)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    const defined = slots(block(themeCss, ':root'));
    for (const name of used) expect(defined.has(name), name).toBe(true);
  });

  it('亮 / 暗挂同一套 HighlightStyle(同 tag 同 class),注入样式取 var(--md-syntax-*)', async () => {
    const light = await mount('light');
    const lightClass = highlightingFor(light.state, [tags.keyword]);
    expect(injectedCss()).toContain('var(--md-syntax-keyword)');
    cleanup();
    const dark = await mount('dark');
    expect(highlightingFor(dark.state, [tags.keyword])).toBe(lightClass);
  });
});

// Markdown 编辑模式(Crepe)的代码块:不传 theme 时 Crepe 用 oneDark,亮色主题下仍是深色配色(正文 #abb2bf 压在
// 浅底上)。改用同一套 --md-syntax-* HighlightStyle,亮 / 暗同一个扩展;代码块底色由 Crepe CSS 取
// --crepe-color-surface(= --md-surface-container),语法色对它同样 ≥ 4.5。
describe('Markdown 编辑模式代码块主题', () => {
  const themeCss = readFileSync(join(process.cwd(), 'src/styles/theme.css'), 'utf8');
  const tokensCss = readFileSync(join(process.cwd(), 'src/styles/design-tokens.css'), 'utf8');
  const block = (css: string, sel: ':root' | '.dark'): string =>
    css.match(new RegExp(`${sel === ':root' ? ':root' : '\\.dark'}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
  const hex = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lum = (h: string): number => {
    const [r, g, b] = hex(h).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it('Markdown 代码块的 CodeMirror 聚焦时同样不画内置 dotted 轮廓', () => {
    const view = new EditorView({
      state: EditorState.create({ doc: 'x', extensions: [markdownCodeBlockTheme] }),
    });
    try {
      // 主题类挂在 view.dom 上,注入的规则以它为前缀
      const themeClasses = [...view.dom.classList].filter((c) => !c.startsWith('cm-'));
      const css = injectedCss();
      expect(
        themeClasses.some((c) => new RegExp(`\\.${c}\\.cm-focused\\s*\\{\\s*outline:\\s*none`).test(css)),
      ).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it('与代码编辑器同一套 HighlightStyle(同 tag 同 class),不声明 dark(亮 / 暗共用一个扩展)', async () => {
    const editor = await mount('light');
    const view = new EditorView({
      state: EditorState.create({ doc: 'const a = 1;', extensions: [markdownCodeBlockTheme] }),
    });
    try {
      expect(highlightingFor(view.state, [tags.keyword])).toBe(highlightingFor(editor.state, [tags.keyword]));
      expect(view.state.facet(EditorView.darkTheme)).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it.each([':root', '.dark'] as const)('%s:每个语法色对代码块底色(--md-surface-container)≥ 4.5', (sel) => {
    const surface = block(tokensCss, sel).match(/--md-surface-container:\s*(#[0-9a-f]{6});/i)?.[1] ?? '';
    expect(surface).not.toBe('');
    const slots = [...block(themeCss, sel).matchAll(/(--md-syntax-[a-z-]+):\s*(#[0-9a-f]{6});/gi)];
    expect(slots.length).toBeGreaterThanOrEqual(8);
    for (const [, name, color] of slots) {
      expect(contrast(color!, surface), `${sel} ${name} ${color}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
