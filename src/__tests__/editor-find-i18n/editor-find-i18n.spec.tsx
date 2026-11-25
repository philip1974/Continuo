// @vitest-environment jsdom
// BDD:编辑器 ⌘F 查找 / 替换面板(CodeMirror @codemirror/search)随界面语言显示,外观走设计 token(对齐 VSCode 查找控件)。
import React from 'react';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { CODEMIRROR_PHRASE_KEYS, codeMirrorPhrases } from '../../panels/Editor/codemirror-phrases';
import { ThemeContext } from '../../theme/ThemeProvider';
import { getLocale, notifyLocaleChange, setLocale, t, type Locale } from '../../i18n';

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

function switchLocale(locale: Locale): void {
  act(() => {
    setLocale(locale);
    notifyLocaleChange();
  });
}

async function mount(): Promise<EditorView> {
  const utils = render(
    <ThemeContext.Provider value={{ mode: 'dark', resolved: 'dark', setMode: () => {} }}>
      <CodeEditor tabId="/find.ts" value={'const a = 1;\n'} fileName="find.ts" />
    </ThemeContext.Provider>,
  );
  await act(async () => {});
  const el = utils.container.querySelector<HTMLElement>('.cm-editor');
  if (!el) throw new Error('no .cm-editor');
  return EditorView.findFromDOM(el)!;
}

/** ⌘F / Ctrl+F(jsdom 平台非 mac → Mod = Ctrl):basicSetup 的 searchKeymap 打开面板。 */
function openSearchPanel(view: EditorView): void {
  runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }), 'editor');
}

/** 面板里按 Esc 关闭。 */
function closeSearchPanel(view: EditorView): void {
  runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Escape' }), 'search-panel');
}

function panelText(view: EditorView): { placeholders: string[]; text: string } {
  const panel = view.dom.querySelector<HTMLElement>('.cm-search');
  if (!panel) throw new Error('no search panel');
  const placeholders = [...panel.querySelectorAll('input[placeholder]')].map((i) => i.getAttribute('placeholder') ?? '');
  return { placeholders, text: panel.textContent ?? '' };
}

/** @codemirror/search 实际调用的全部 phrase(从已安装包的源码里收集,防升级新增漏翻)。 */
function searchPackagePhrases(): string[] {
  // @codemirror/search 不是直接依赖:从 codemirror 包(basicSetup 的来源)所在位置解析。
  const fromCodemirror = createRequire(realpathSync(join(process.cwd(), 'node_modules/codemirror/package.json')));
  const entry = fromCodemirror.resolve('@codemirror/search');
  const src = readFileSync(join(dirname(entry), 'index.js'), 'utf8');
  const found = new Set<string>();
  for (const m of src.matchAll(/phrase\((?:view|state|[a-z.]+), ?"([^"]+)"|\.phrase\("([^"]+)"/g)) found.add(m[1] ?? m[2]!);
  return [...found];
}

let original: Locale;
beforeEach(() => {
  original = getLocale();
  // jsdom 无 Range 布局 API:CodeMirror 打开面板后测量选区会报错刷屏(不影响断言),补最小桩。
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => {
  cleanup();
  switchLocale(original);
});

describe('编辑器查找面板随界面语言', () => {
  it('zh:查找 / 替换输入框占位、按钮、选项都是中文', async () => {
    switchLocale('zh');
    const view = await mount();
    act(() => void openSearchPanel(view));
    const { placeholders, text } = panelText(view);
    expect(placeholders).toContain(t('editor.cm.find'));
    expect(placeholders).toContain(t('editor.cm.replace'));
    for (const key of ['editor.cm.next', 'editor.cm.previous', 'editor.cm.all', 'editor.cm.match_case', 'editor.cm.regexp', 'editor.cm.by_word', 'editor.cm.replace_all'] as const) {
      expect(text).toContain(t(key));
    }
    expect(text).not.toMatch(/match case|regexp|by word|replace all/);
    expect(view.dom.querySelector('.cm-search [name="close"]')?.getAttribute('aria-label')).toBe(t('editor.cm.close'));
  });

  it('切换语言后(不重建编辑器)重新打开的面板换成新语言', async () => {
    switchLocale('en');
    const view = await mount();
    act(() => void openSearchPanel(view));
    expect(panelText(view).placeholders).toContain('Find');
    act(() => void closeSearchPanel(view));
    switchLocale('ko');
    await act(async () => {});
    // 同一个 EditorView(语言切换走 Compartment.reconfigure,不重挂)
    expect(EditorView.findFromDOM(view.dom)).toBe(view);
    act(() => void openSearchPanel(view));
    expect(panelText(view).placeholders).toContain(t('editor.cm.find'));
    expect(panelText(view).text).toContain(t('editor.cm.replace_all'));
  });

  it('@codemirror/search 的全部 phrase 都有 catalog 映射,zh / ko 都已翻译', () => {
    const phrases = searchPackagePhrases();
    expect(phrases.length).toBeGreaterThanOrEqual(15);
    for (const p of phrases) expect(CODEMIRROR_PHRASE_KEYS, `phrase "${p}" 未映射`).toHaveProperty(p);
    for (const locale of ['zh', 'ko'] as const) {
      switchLocale(locale);
      const state = EditorState.create({ extensions: codeMirrorPhrases() });
      for (const p of phrases) expect(state.phrase(p), `${locale}:${p}`).not.toBe(p);
    }
  });
});

describe('查找面板外观走设计 token(亮 / 暗)', () => {
  it('输入框 / 按钮 / 复选框样式引用 --md-* token', async () => {
    const view = await mount();
    act(() => void openSearchPanel(view));
    const css = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n') +
      (document.adoptedStyleSheets ?? []).flatMap((s) => [...s.cssRules].map((r) => r.cssText)).join('\n');
    expect(css).toMatch(/\.cm-textfield[^{]*\{[^}]*var\(--md-outline-variant\)/);
    expect(css).toMatch(/\.cm-button[^{]*\{[^}]*var\(--md-/);
    expect(css).toMatch(/input\[type=["']?checkbox["']?\][^{]*\{[^}]*accent-color:\s*var\(--md-primary\)/);
    // 暗色:面板声明 color-scheme: dark(未勾选的原生复选框不是白方块)
    expect(css).toMatch(/\.cm-panel\s*\{[^}]*color-scheme:\s*dark/);
  });
});
