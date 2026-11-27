// @vitest-environment jsdom
// BDD: editor-occurrences-highlight —— 光标停在词内(无选区)高亮该词的其它出现处(VSCode editor.occurrencesHighlight 默认
// singleFile,无语言服务时按文本兜底)。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';
import { useIndentationStore } from '../../panels/Editor/editor-indentation';
import { EDITOR_OCCURRENCES_HIGHLIGHT } from '../../plugins/settings/core-setting-specs';
import { bootCorePlugins, shutdownCorePlugins } from '../../core-plugins';
import { coApp } from '../../plugins/co-app';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'source' });
  useSettingsValuesStore.setState({ values: {} });
  useIndentationStore.setState({ byTab: new Map() });
});
afterEach(() => {
  useEditorStore.setState({ tabs: [] });
  cleanup();
});

function open(p: string, content: string, forceLanguage?: 'markdown'): EditorView {
  useEditorStore.getState().openTab(createTab(p, content));
  render(<CodeEditor tabId={p} value={content} fileName={p.slice(p.lastIndexOf('/') + 1)} forceLanguage={forceLanguage} />);
  return useEditorStore.getState().viewRefs.get(p) as EditorView;
}

/** 高亮的文字(按文档顺序);main = 光标处那一个。 */
function highlighted(view: EditorView): { text: string; main: boolean }[] {
  return [...view.contentDOM.querySelectorAll('.cm-selectionMatch')].map((el) => ({
    text: el.textContent ?? '',
    main: el.classList.contains('cm-selectionMatch-main'),
  }));
}

const cursor = (view: EditorView, pos: number) => act(() => view.dispatch({ selection: EditorSelection.cursor(pos) }));

const SRC = 'const foo = 1;\nfoo + foo;\nfood + Foo + foo_bar;\n';

describe('光标处单词的其它出现处', () => {
  it('默认开:光标在词内(无选区)→ 同一个词的每个出现处都高亮(含光标处),区分大小写、全词匹配', () => {
    const view = open('/w/a.ts', SRC);
    cursor(view, SRC.indexOf('foo') + 1);
    expect(highlighted(view)).toEqual([
      { text: 'foo', main: true },
      { text: 'foo', main: false },
      { text: 'foo', main: false },
    ]);
  });

  it('光标紧挨词尾也算在词上;光标不在词上(空白 / 标点之间)→ 不高亮', () => {
    const view = open('/w/a.ts', SRC);
    cursor(view, SRC.indexOf('foo') + 3);
    expect(highlighted(view)).toHaveLength(3);
    cursor(view, SRC.indexOf(' = ') + 1);
    expect(highlighted(view)).toEqual([]);
  });

  it('多光标不高亮(VSCode 只看单一选区)', () => {
    const view = open('/w/a.ts', SRC);
    act(() =>
      view.dispatch({
        selection: EditorSelection.create([EditorSelection.cursor(7), EditorSelection.cursor(16)]),
      }),
    );
    expect(highlighted(view)).toEqual([]);
  });

  it('Markdown 源码模式同样生效', () => {
    const md = 'alpha beta\n\nbeta gamma\n';
    const view = open('/w/n.md', md, 'markdown');
    cursor(view, md.indexOf('beta') + 1);
    expect(highlighted(view).map((h) => h.text)).toEqual(['beta', 'beta']);
  });

  it('设置 off → 光标处单词不高亮,有选区时的相同文本高亮照旧;改回 singleFile 恢复(同一个视图)', () => {
    const view = open('/w/a.ts', SRC);
    act(() => useSettingsValuesStore.getState().setValue(EDITOR_OCCURRENCES_HIGHLIGHT.id, 'off'));
    cursor(view, SRC.indexOf('foo') + 1);
    expect(highlighted(view)).toEqual([]);
    act(() => view.dispatch({ selection: EditorSelection.single(SRC.indexOf('foo'), SRC.indexOf('foo') + 3) }));
    expect(highlighted(view).length).toBeGreaterThan(0);
    act(() => useSettingsValuesStore.getState().setValue(EDITOR_OCCURRENCES_HIGHLIGHT.id, 'singleFile'));
    expect(useEditorStore.getState().viewRefs.get('/w/a.ts')).toBe(view);
    cursor(view, SRC.indexOf('foo') + 1);
    expect(highlighted(view)).toHaveLength(3);
  });

  it('设置项:editor.occurrencesHighlight,下拉 off / singleFile,默认 singleFile,编辑器 → 外观;三语文案', () => {
    expect(EDITOR_OCCURRENCES_HIGHLIGHT).toMatchObject({
      id: 'editor.occurrencesHighlight',
      category: 'editor',
      group: 'appearance',
      type: 'select',
      default: 'singleFile',
    });
    expect(EDITOR_OCCURRENCES_HIGHLIGHT.enum?.map((e) => e.value)).toEqual(['off', 'singleFile']);
    bootCorePlugins();
    try {
      expect(coApp.settingItems.get('editor.occurrencesHighlight')).toBeTruthy();
    } finally {
      shutdownCorePlugins();
    }
    for (const k of [
      'settings.editor.occurrences_highlight',
      'settings.editor.occurrences_highlight.desc',
      'settings.editor.occurrences_highlight.off',
      'settings.editor.occurrences_highlight.single_file',
    ] as const) {
      for (const cat of [en, zh, ko]) expect(cat[k]).toBeTruthy();
    }
  });
});
