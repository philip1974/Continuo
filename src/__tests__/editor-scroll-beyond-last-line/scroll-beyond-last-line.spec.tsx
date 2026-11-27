// @vitest-environment jsdom
// BDD: editor-scroll-beyond-last-line —— editor.scrollBeyondLastLine(默认开)→ CodeMirror scrollPastEnd。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { createTab, liveEditorViewOf, useEditorStore } from '../../stores/editor.store';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';
import { EDITOR_SCROLL_BEYOND_LAST_LINE } from '../../plugins/settings/core-setting-specs';
import { bootCorePlugins, shutdownCorePlugins } from '../../core-plugins';
import { coApp } from '../../plugins/co-app';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

beforeEach(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  useSettingsValuesStore.setState({ values: {} });
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'source' });
});
afterEach(() => {
  cleanup();
  useEditorStore.setState({ tabs: [] });
});

/** scrollPastEnd 在内容区写入的底部留白(paddingBottom 内联样式);未挂 → 空串。 */
function bottomSpace(path: string): string {
  const view = liveEditorViewOf(path, useEditorStore.getState().activeGroupId)!;
  return view.contentDOM.style.paddingBottom;
}

function mount(path: string, forceLanguage?: 'markdown') {
  useEditorStore.getState().openTab(createTab(path, 'a\nb\n'));
  render(<CodeEditor tabId={path} value={'a\nb\n'} fileName={path.slice(3)} forceLanguage={forceLanguage} />);
}

describe('滚动超过最后一行', () => {
  it('默认开:代码编辑器内容区底部留出空白(scrollPastEnd)', () => {
    mount('/w/a.ts');
    expect(bottomSpace('/w/a.ts')).not.toBe('');
  });

  it('Markdown 源码模式同样生效(VSCode 对 Markdown 无语言级覆盖)', () => {
    mount('/w/n.md', 'markdown');
    expect(bottomSpace('/w/n.md')).not.toBe('');
  });

  it('关掉设置 → 即时去掉底部空白(同一个视图,光标保留);再开恢复', () => {
    mount('/w/a.ts');
    const view = liveEditorViewOf('/w/a.ts', useEditorStore.getState().activeGroupId)!;
    act(() => view.dispatch({ selection: { anchor: 2 } }));
    act(() => useSettingsValuesStore.getState().setValue(EDITOR_SCROLL_BEYOND_LAST_LINE.id, false));
    expect(liveEditorViewOf('/w/a.ts', useEditorStore.getState().activeGroupId)).toBe(view);
    expect(bottomSpace('/w/a.ts')).toBe('');
    expect(view.state.selection.main.head).toBe(2);
    act(() => useSettingsValuesStore.getState().setValue(EDITOR_SCROLL_BEYOND_LAST_LINE.id, true));
    expect(bottomSpace('/w/a.ts')).not.toBe('');
  });

  it('设置项:editor.scrollBeyondLastLine,布尔,默认开,编辑器 → 外观;三语说明照抄 VSCode', () => {
    expect(EDITOR_SCROLL_BEYOND_LAST_LINE).toMatchObject({
      id: 'editor.scrollBeyondLastLine',
      category: 'editor',
      group: 'appearance',
      type: 'boolean',
      default: true,
    });
    bootCorePlugins();
    try {
      expect(coApp.settingItems.get('editor.scrollBeyondLastLine')).toBeTruthy();
    } finally {
      shutdownCorePlugins();
    }
    const k = 'settings.editor.scroll_beyond_last_line.desc' as const;
    expect([en[k], zh[k], ko[k]]).toEqual([
      'Controls whether the editor will scroll beyond the last line.',
      '控制编辑器是否可以滚动到最后一行之后。',
      '편집기에서 마지막 줄 이후로 스크롤할지 여부를 제어합니다.',
    ]);
    expect(zh['settings.editor.scroll_beyond_last_line']).toBeTruthy();
    expect(ko['settings.editor.scroll_beyond_last_line']).toBeTruthy();
  });
});
