// @vitest-environment jsdom
// 日志与 JSON 家族文件的语法高亮(对齐 VSCode 内置 Log 语言与 extensions/json 的扩展名;BDD: README.md)。
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree, highlightingFor, language } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { CodeEditor, languageDescriptionFor, pickLanguage } from '../../panels/Editor/CodeEditor';
import { tokenizeLogLine } from '../../panels/Editor/codemirror-log-language';
import { logTags } from '../../panels/Editor/codemirror-log-tags';
import { codeEditorTheme } from '../../panels/Editor/code-editor-theme';
import { languageIdOf } from '../../panels/Editor/codemirror-language-commands';
import { ThemeContext } from '../../theme/ThemeProvider';

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => cleanup());

function nodeNames(doc: string, lang: Extension): string[] {
  const state = EditorState.create({ doc, extensions: [lang] });
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  const names: string[] = [];
  tree?.iterate({ enter: (n) => void names.push(n.name) });
  return names;
}

/** 一行里被着色的片段:token → 文本列表。 */
function tokensOf(line: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [text, token] of tokenizeLogLine(line)) if (token) (out[token] ??= []).push(text);
  return out;
}

describe('Log 语言(VSCode extensions/log:`.log` 与 `*.log.?`)', () => {
  it.each(['app.log', '/var/log/system.log', 'APP.LOG', 'app.log.1', 'C:\\logs\\x.log'])('%s → Log', (file) => {
    expect(languageDescriptionFor(file)?.name).toBe('Log');
  });

  it.each(['app.log.10', 'log', 'catalog', 'a.logs'])('%s 不是 Log(`*.log.?` 只认一个字符的后缀)', (file) => {
    expect(languageDescriptionFor(file)?.name).not.toBe('Log');
  });

  it('日期 / 时间、级别关键字按语义着色', () => {
    expect(tokensOf('2026-11-28 10:00:01.123 ERROR request failed')).toMatchObject({
      date: ['2026-11-28', '10:00:01.123'],
      error: ['ERROR'],
    });
    expect(tokensOf('2026-11-28T10:00:01Z [warn] disk low')).toMatchObject({ date: ['2026-11-28', 'T10:00:01Z'], warning: ['[warn]'] });
    expect(tokensOf('INFO started').info).toEqual(['INFO']);
    expect(tokensOf('DEBUG x').debug).toEqual(['DEBUG']);
    expect(tokensOf('TRACE y').verbose).toEqual(['TRACE']);
    expect(tokensOf('12:00:01 E boom').error).toEqual(['E']);
    expect(tokensOf('Fatal: x').error).toEqual(['Fatal']);
    expect(tokensOf('error: bad').error).toEqual(['error:']);
    // 普通单词里的 e / info 不着色
    expect(tokensOf('the user information page')).toEqual({});
  });

  it('GUID、数字 / 布尔、十六进制、URL、带点的名字、引号字符串、异常类型、栈帧', () => {
    expect(tokensOf('id=3f2504e0-4f89-11d3-9a0c-0305e82c3301 n=42 ok=true p=0x1F').constant).toEqual([
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      '42',
      'true',
      '0x1F',
    ]);
    expect(tokensOf('GET https://example.com/a?b=1 from api.example.com').constant).toEqual([
      'https://example.com/a?b=1',
      'api.example.com',
    ]);
    expect(tokensOf('msg "hello world" and \'single\'').string).toEqual(['"hello world"', "'single'"]);
    expect(tokensOf('java.lang.NullPointerException: oops').exceptionType).toEqual(['java.lang.NullPointerException']);
    expect(tokenizeLogLine('    at com.example.Foo.bar(Foo.java:42)')).toEqual([
      ['    at com.example.Foo.bar(Foo.java:42)', 'stackFrame'],
    ]);
  });

  it('打开 .log:加载后换上 Log 语言,级别按主题语义色着色(错误 = 红 + 粗体,含高对比度两套)', async () => {
    const utils = render(
      <ThemeContext.Provider value={{ mode: 'dark', resolved: 'dark', setMode: () => {} }}>
        <CodeEditor tabId="/t.log" value={'2026-11-28 ERROR boom\n'} fileName="t.log" />
      </ThemeContext.Provider>,
    );
    await act(async () => {});
    const view = EditorView.findFromDOM(utils.container.querySelector<HTMLElement>('.cm-editor')!)!;
    await waitFor(() => expect(view.state.facet(language)?.name).toBe('log'));
    expect(languageIdOf(view)).toBe('log');
    for (const resolved of ['dark', 'light', 'hcDark', 'hcLight'] as const) {
      const state = EditorState.create({ extensions: [codeEditorTheme(resolved)] });
      expect(highlightingFor(state, [logTags.error]), resolved).toBeTruthy();
      expect(highlightingFor(state, [logTags.error])).not.toBe(highlightingFor(state, [logTags.info]));
      expect(highlightingFor(state, [logTags.warning])).not.toBe(highlightingFor(state, [logTags.info]));
    }
  });
});

describe('Log 语言渲染出的 DOM(四套主题)', () => {
  it.each(['dark', 'light', 'hcDark', 'hcLight'] as const)(
    '%s:ERROR / FATAL 的 span 带 logTags.error 的高亮类(红色粗体),不是通用 invalid;字符串带 logTags.string 的类',
    async (resolved) => {
      const utils = render(
        <ThemeContext.Provider value={{ mode: resolved, resolved, setMode: () => {} }}>
          <CodeEditor tabId={`/${resolved}.log`} value={'ERROR boom "quoted"\nFATAL down\nINFO ok\n'} fileName="t.log" />
        </ThemeContext.Provider>,
      );
      await act(async () => {});
      const view = EditorView.findFromDOM(utils.container.querySelector<HTMLElement>('.cm-editor')!)!;
      await waitFor(() => expect(view.state.facet(language)?.name).toBe('log'));
      // 文本所在 span 及其到行为止的祖先的全部类(选中匹配等装饰会再套一层 span)
      const classesOf = (text: string): string[] => {
        let el: Element | null =
          [...view.contentDOM.querySelectorAll('span')].findLast((e) => e.textContent === text) ?? null;
        const out: string[] = [];
        for (; el && !el.classList.contains('cm-line'); el = el.parentElement) out.push(...el.classList);
        return out;
      };
      await waitFor(() => expect(classesOf('ERROR')).not.toEqual([]));
      const errorClass = highlightingFor(view.state, [logTags.error])!;
      const invalidClass = highlightingFor(view.state, [tags.invalid]);
      expect(errorClass).toBeTruthy();
      expect(errorClass).not.toBe(invalidClass);
      for (const word of ['ERROR', 'FATAL']) expect(classesOf(word), word).toContain(errorClass);
      expect(classesOf('"quoted"')).toContain(highlightingFor(view.state, [logTags.string])!);
      expect(classesOf('INFO')).toContain(highlightingFor(view.state, [logTags.info])!);
    },
  );
});

describe('JSON 家族(VSCode extensions/json)', () => {
  it.each(['site.webmanifest', 'trace.har', 'map.geojson', 'n.ipynb', '.eslintrc', '.babelrc'])('%s → JSON 同步高亮', (file) => {
    const names = nodeNames('{"a": [1, "x"]}\n', pickLanguage(file));
    expect(names).toContain('Property');
    expect(languageDescriptionFor(file)).toBeNull();
  });

  it.each(['composer.lock', '.watchmanconfig'])('%s → JSON(按文件名)', (file) => {
    expect(languageDescriptionFor(file)?.name).toBe('JSON');
  });

  it.each(['events.jsonl', 'events.ndjson'])('%s:每行一个 JSON 值,逐行都解析出对象;语言名 jsonl(不提供 JSON 格式化)', (file) => {
    const lang = pickLanguage(file);
    const names = nodeNames('{"a": 1}\n{"b": [true, null]}\n{"c": "x"}\n', lang);
    expect(names.filter((n) => n === 'Object')).toHaveLength(3);
    expect(names).toContain('Array');
    const state = EditorState.create({ doc: '{}', extensions: [lang] });
    expect(state.facet(language)?.name).toBe('jsonl');
  });
});
