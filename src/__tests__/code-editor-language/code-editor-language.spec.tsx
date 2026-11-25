// @vitest-environment jsdom
// 代码编辑器按文件名选语言:TS 泛型箭头函数不打断高亮;常见语言按 language-data 懒加载高亮(BDD: README.md)。
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, language, type LanguageSupport, type LanguageDescription } from '@codemirror/language';
import { CodeEditor, languageDescriptionFor, pickLanguage } from '../../panels/Editor/CodeEditor';
import { ThemeContext } from '../../theme/ThemeProvider';

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

function nodeNames(doc: string, lang: Extension): string[] {
  const state = EditorState.create({ doc, extensions: [lang] });
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  const names: string[] = [];
  tree?.iterate({ enter: (n) => void names.push(n.name) });
  return names;
}

function Editor({ fileName, value }: { fileName: string; value: string }) {
  return (
    <ThemeContext.Provider value={{ mode: 'dark', resolved: 'dark', setMode: () => {} }}>
      <CodeEditor tabId="/tab" value={value} fileName={fileName} />
    </ThemeContext.Provider>
  );
}

async function mount(fileName: string, value: string) {
  const utils = render(<Editor fileName={fileName} value={value} />);
  await act(async () => {});
  const el = utils.container.querySelector<HTMLElement>('.cm-editor');
  if (!el) throw new Error('no .cm-editor');
  return { ...utils, view: EditorView.findFromDOM(el)! };
}

const languageName = (view: EditorView): string | undefined => view.state.facet(language)?.name;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TypeScript / JavaScript 的 JSX 配置按扩展名区分', () => {
  const GENERIC_ARROW = 'const id = <T>(x: T): T => x;\nconst y: number = 1;\n';

  it.each(['gen.ts', 'gen.mts', 'gen.cts', 'GEN.TS'])('%s:泛型箭头函数按 TypeScript 解析,无语法错误,后续代码照常解析', (file) => {
    const names = nodeNames(GENERIC_ARROW, pickLanguage(file));
    expect(names).not.toContain('⚠');
    expect(names).toContain('ArrowFunction');
    expect(names).toContain('TypeParamList');
    expect(names.filter((n) => n === 'VariableDeclaration')).toHaveLength(2);
  });

  it.each(['view.tsx', 'view.jsx', 'view.js'])('%s:JSX 标签按 JSX 解析', (file) => {
    expect(nodeNames('const a = <div className="x">hi</div>;\n', pickLanguage(file))).toContain('JSXElement');
  });

  it.each(['m.mjs', 'c.cjs'])('%s:纯 JavaScript(不开 JSX / TypeScript)', (file) => {
    const names = nodeNames('const a = (x) => x + 1;\n', pickLanguage(file));
    expect(names).not.toContain('⚠');
    expect(nodeNames('const a = <div>hi</div>;\n', pickLanguage(file))).not.toContain('JSXElement');
    expect(nodeNames('const id = <T>(x: T): T => x;\n', pickLanguage(file))).not.toContain('TypeParamList');
  });
});

describe('同步给出的语言', () => {
  it('.jsonc / .json5 按 JSON 解析(注释不着色,其余照常)', () => {
    for (const file of ['settings.jsonc', 'a.json5']) {
      const names = nodeNames('{\n  // c\n  "a": [1, "x"]\n}\n', pickLanguage(file));
      expect(names).toContain('Property');
      expect(names).toContain('Array');
    }
  });

  it('.mdx 按 Markdown + frontmatter 解析', () => {
    const names = nodeNames('---\ntitle: T\n---\n\n# H\n', pickLanguage('page.mdx'));
    expect(names).toContain('ATXHeading1');
    expect(names).not.toContain('SetextHeading2');
  });

  it('认不出的文件 → 纯文本(稳定空扩展),同步语言不经语言表', () => {
    expect(pickLanguage('README')).toEqual([]);
    expect(languageDescriptionFor('README')).toBeNull();
    expect(languageDescriptionFor('notes.unknown')).toBeNull();
    for (const f of ['a.ts', 'a.tsx', 'a.js', 'a.json', 'a.jsonc', 'a.css', 'a.html', 'a.md', 'a.mdx']) {
      expect(languageDescriptionFor(f), f).toBeNull();
    }
  });
});

describe('常见语言按 language-data 语言表匹配(与 Markdown 代码块同源)', () => {
  it.each([
    ['main.py', 'Python'],
    ['/repo/src/main.go', 'Go'],
    ['lib.rs', 'Rust'],
    ['ci.yaml', 'YAML'],
    ['ci.yml', 'YAML'],
    ['Cargo.toml', 'TOML'],
    ['run.sh', 'Shell'],
    ['style.scss', 'SCSS'],
    ['q.sql', 'SQL'],
    ['pom.xml', 'XML'],
    ['App.java', 'Java'],
    ['main.c', 'C'],
    ['App.vue', 'Vue'],
    ['MAIN.PY', 'Python'],
    ['C:\\repo\\main.py', 'Python'],
  ])('%s → %s', (file, name) => {
    expect(languageDescriptionFor(file)?.name).toBe(name);
  });

  it.each([
    ['Dockerfile', 'Dockerfile'],
    ['/repo/Dockerfile.dev', 'Dockerfile'],
    ['app.dockerfile', 'Dockerfile'],
    ['Containerfile', 'Dockerfile'],
    ['.env', 'Properties files'],
    ['/repo/.env.local', 'Properties files'],
    ['.zshrc', 'Shell'],
    ['.bashrc', 'Shell'],
    ['.profile', 'Shell'],
    ['init.zsh', 'Shell'],
    ['Makefile', 'Shell'],
    ['GNUmakefile', 'Shell'],
    ['rules.mk', 'Shell'],
  ])('补充文件名:%s → %s', (file, name) => {
    expect(languageDescriptionFor(file)?.name).toBe(name);
  });
});

describe('懒加载语言包', () => {
  it('打开 .py:加载前纯文本,加载后原地换上 Python 高亮,编辑器不重建', async () => {
    const { view, container } = await mount('a.py', 'def f():\n    return 1\n');
    const dom = view.dom;
    await waitFor(() => expect(languageName(view)).toBe('python'));
    expect(container.querySelector('.cm-editor')).toBe(dom);
    const names: string[] = [];
    ensureSyntaxTree(view.state, view.state.doc.length, 5000)?.iterate({ enter: (n) => void names.push(n.name) });
    expect(names).toContain('FunctionDefinition');
    // 加载过一次后再打开即同步高亮
    cleanup();
    const again = await mount('b.py', 'x = 1\n');
    expect(languageName(again.view)).toBe('python');
  });

  it('加载中文件改名(换语言)→ 旧文件的加载结果不套用到新文件', async () => {
    const go = languageDescriptionFor('a.go')!;
    const pending = deferred<LanguageSupport>();
    vi.spyOn(go, 'load').mockReturnValue(pending.promise);
    const { view, rerender } = await mount('a.go', 'package main\n');
    expect(languageName(view)).toBeUndefined();
    rerender(<Editor fileName="a.rs" value="package main\n" />);
    await waitFor(() => expect(languageName(view)).toBe('rust'));
    // 迟到的「Go」结果(用另一种语言的支持冒充,能看出是否被套用)
    const stale = await languageDescriptionFor('x.py')!.load();
    await act(async () => pending.resolve(stale));
    expect(languageName(view)).toBe('rust');
  });

  it('加载中改名为同步语言(.ts)→ 迟到结果不覆盖', async () => {
    const java = languageDescriptionFor('A.java')!;
    const pending = deferred<LanguageSupport>();
    vi.spyOn(java, 'load').mockReturnValue(pending.promise);
    const { view, rerender } = await mount('A.java', 'class A {}\n');
    rerender(<Editor fileName="A.ts" value="class A {}\n" />);
    await act(async () => {});
    expect(languageName(view)).toBe('typescript');
    const py = await languageDescriptionFor('x.py')!.load();
    await act(async () => pending.resolve(py));
    expect(languageName(view)).toBe('typescript');
  });

  it('加载中卸载 → 迟到结果被丢弃,不报错', async () => {
    const c = languageDescriptionFor('main.c')!;
    const pending = deferred<LanguageSupport>();
    vi.spyOn(c, 'load').mockReturnValue(pending.promise);
    const errors = vi.spyOn(console, 'error');
    const { view, unmount } = await mount('main.c', 'int main(void) { return 0; }\n');
    unmount();
    const py = await languageDescriptionFor('x.py')!.load();
    await act(async () => pending.resolve(py));
    expect(languageName(view)).toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
  });

  it('语言包加载失败 → 保持纯文本,不抛未处理错误', async () => {
    const sql = languageDescriptionFor('q.sql') as LanguageDescription;
    vi.spyOn(sql, 'load').mockRejectedValue(new Error('chunk load failed'));
    const { view } = await mount('q.sql', 'select 1;\n');
    await act(async () => {});
    expect(languageName(view)).toBeUndefined();
  });
});
