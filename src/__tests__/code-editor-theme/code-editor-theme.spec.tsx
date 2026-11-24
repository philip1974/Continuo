// @vitest-environment jsdom
// 代码编辑器(CodeEditor:代码文件 + Markdown Source 模式)的外观与 Markdown frontmatter 解析。
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, highlightingFor } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { CodeEditor, pickLanguage } from '../../panels/Editor/CodeEditor';
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
  it.each(['dark', 'light'] as const)('%s:背景 / gutter / 字体取自 --md-* / --wm-font-mono,不带 oneDark 固定底色', async (theme) => {
    await mount(theme);
    const css = injectedCss();
    expect(css).toMatch(/background(-color)?:\s*var\(--md-surface\)/);
    expect(css).toContain('var(--wm-font-mono)');
    expect(css).toMatch(/\.cm-gutters[^}]*var\(--md-/);
    expect(css).not.toMatch(/#282c34/i);
  });

  it('暗色声明为 dark 主题,亮色不是(CodeMirror 内建样式按此选亮 / 暗变体)', async () => {
    expect((await mount('dark')).state.facet(EditorView.darkTheme)).toBe(true);
    cleanup();
    expect((await mount('light')).state.facet(EditorView.darkTheme)).toBe(false);
  });

  it('亮色有语法高亮且标题不加下划线;暗色沿用 oneDark 配色', async () => {
    const light = await mount('light');
    expect(highlightingFor(light.state, [tags.keyword])).toBeTruthy();
    const headingClass = highlightingFor(light.state, [tags.heading]);
    expect(headingClass).toBeTruthy();
    const css = injectedCss();
    const rule = css.split('}').find((r) => headingClass!.split(' ').some((c) => r.includes(`.${c}`)));
    expect(rule ?? '').not.toContain('underline');
    cleanup();

    const dark = await mount('dark');
    expect(highlightingFor(dark.state, [tags.keyword])).toBeTruthy();
    expect(injectedCss()).toMatch(/#c678dd/i); // oneDark keyword 紫
  });
});
