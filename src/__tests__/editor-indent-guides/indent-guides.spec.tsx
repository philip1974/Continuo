// @vitest-environment jsdom
// BDD: editor-indent-guides —— 缩进参考线(VSCode editor.guides.indentation / highlightActiveIndentation 默认开)。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { createTab, useEditorStore } from '../../stores/editor.store';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';
import { useIndentationStore } from '../../panels/Editor/editor-indentation';
import { EDITOR_GUIDES_INDENTATION } from '../../plugins/settings/core-setting-specs';
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

/** 第 n 行(1 起)的行元素。 */
const lineEl = (view: EditorView, n: number) => view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')[n - 1]!;
const hasGuides = (view: EditorView, n: number) => lineEl(view, n).classList.contains('cm-indent-markers');
/** 该行参考线里是否有当前块高亮的那一条。 */
const hasActiveGuide = (view: EditorView, n: number) =>
  lineEl(view, n).getAttribute('style')?.includes('--indent-marker-active-bg-color') ?? false;

const TS = 'function f() {\n    if (x) {\n        return 1;\n    }\n    return 2;\n}\n';

describe('缩进参考线', () => {
  it('默认开:有缩进的行画参考线,顶格行不画', () => {
    const view = open('/w/a.ts', TS);
    expect(hasGuides(view, 1)).toBe(false);
    expect(hasGuides(view, 2)).toBe(true);
    expect(hasGuides(view, 3)).toBe(true);
    expect(hasGuides(view, 6)).toBe(false);
  });

  it('按文档缩进计级:2 空格文件里缩 2 格的行就有一级参考线(不按默认 4 计成 0 级)', () => {
    const view = open('/w/b.ts', 'a {\n  b {\n    c\n  }\n}\n');
    expect(view.state.tabSize).toBe(2);
    expect(hasGuides(view, 2)).toBe(true);
    expect(hasGuides(view, 3)).toBe(true);
  });

  it('tab 缩进按 tabSize 折算列', () => {
    const view = open('/w/c.go', 'func f() {\n\tif x {\n\t\treturn\n\t}\n}\n');
    expect(hasGuides(view, 2)).toBe(true);
    expect(hasGuides(view, 3)).toBe(true);
  });

  it('光标所在块的参考线高亮(VSCode highlightActiveIndentation),其它块不高亮;光标移动随之更新', () => {
    const view = open('/w/a.ts', TS);
    act(() => view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(3).from + 10) }));
    expect(hasActiveGuide(view, 3)).toBe(true);
    expect(hasActiveGuide(view, 5)).toBe(false);
    act(() => view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(5).from + 6) }));
    expect(hasActiveGuide(view, 5)).toBe(true);
    expect(hasActiveGuide(view, 2)).toBe(true); // 同一级(函数体)
  });

  it('Markdown 源码模式同样显示(VSCode 对 Markdown 无语言级覆盖)', () => {
    const view = open('/w/n.md', '- a\n    - b\n        - c\n', 'markdown');
    expect(hasGuides(view, 2)).toBe(true);
  });

  it('关掉设置 → 即时去掉(同一个视图,光标保留);再开恢复', () => {
    const view = open('/w/a.ts', TS);
    act(() => view.dispatch({ selection: EditorSelection.cursor(20) }));
    act(() => useSettingsValuesStore.getState().setValue(EDITOR_GUIDES_INDENTATION.id, false));
    expect(useEditorStore.getState().viewRefs.get('/w/a.ts')).toBe(view);
    expect(view.contentDOM.querySelectorAll('.cm-indent-markers')).toHaveLength(0);
    expect(view.state.selection.main.head).toBe(20);
    act(() => useSettingsValuesStore.getState().setValue(EDITOR_GUIDES_INDENTATION.id, true));
    expect(hasGuides(view, 2)).toBe(true);
  });

  it('颜色取语义 token --md-indent-guide / --md-indent-guide-active,亮 / 暗都有值', () => {
    open('/w/a.ts', TS);
    const css = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    expect(css).toContain('--indent-marker-bg-color: var(--md-indent-guide)');
    expect(css).toContain('--indent-marker-active-bg-color: var(--md-indent-guide-active)');
    const theme = readFileSync(path.resolve(__dirname, '../../styles/theme.css'), 'utf8');
    const dark = theme.slice(theme.indexOf('\n.dark {'));
    const light = theme.slice(0, theme.indexOf('\n.dark {'));
    for (const block of [light, dark]) {
      expect(block).toMatch(/--md-indent-guide: #[0-9a-f]{6};/);
      expect(block).toMatch(/--md-indent-guide-active: #[0-9a-f]{6};/);
    }
  });

  it('设置项:editor.guides.indentation,布尔,默认开,编辑器 → 外观;三语说明', () => {
    expect(EDITOR_GUIDES_INDENTATION).toMatchObject({
      id: 'editor.guides.indentation',
      category: 'editor',
      group: 'appearance',
      type: 'boolean',
      default: true,
    });
    bootCorePlugins();
    try {
      expect(coApp.settingItems.get('editor.guides.indentation')).toBeTruthy();
    } finally {
      shutdownCorePlugins();
    }
    const k = 'settings.editor.guides_indentation.desc' as const;
    expect([en[k], zh[k], ko[k]]).toEqual([
      'Controls whether the editor should render indent guides.',
      '控制编辑器是否显示缩进参考线。',
      '편집기에서 들여쓰기 가이드를 렌더링할지 여부를 제어합니다.',
    ]);
  });
});
