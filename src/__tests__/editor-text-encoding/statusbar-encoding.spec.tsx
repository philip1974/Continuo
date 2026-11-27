// @vitest-environment jsdom
// 状态栏编码 / 行尾项:显示活动文本 tab 的编码与行尾,点击打开更改文件编码 / 更改行尾序列;图片 tab 不显示。行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { StatusBar } from '../../shell/StatusBar';
import { useEditorStore, type EditorTab } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEncodingPickerStore } from '../../plugins/editor-encoding/store';
import { setLocale } from '../../i18n';

function renderTab(tab: Partial<EditorTab> & { filePath: string; content: string }) {
  useEditorStore.setState({
    tabs: [{ id: tab.filePath, originalContent: tab.content, dirty: false, ...tab }],
    activeTabId: tab.filePath,
  });
  return render(<StatusBar />).container;
}

beforeEach(() => {
  _resetLmApiForTest();
  Object.defineProperty(window, 'api', { value: {}, writable: true, configurable: true });
  captureLmApi();
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEncodingPickerStore.getState().close();
  setLocale('en');
});
afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
});

describe('状态栏编码 / 行尾', () => {
  it('显示编码短名与行尾;缺省 UTF-8 / LF', () => {
    let c = renderTab({ filePath: '/w/a.txt', content: 'a\nb' });
    expect(c.querySelector('[data-statusbar-encoding]')?.textContent).toBe('UTF-8');
    expect(c.querySelector('[data-statusbar-eol]')?.textContent).toBe('LF');
    cleanup();
    c = renderTab({ filePath: '/w/b.txt', content: 'a\r\nb\r\n', encoding: 'utf16le' });
    expect(c.querySelector('[data-statusbar-encoding]')?.textContent).toBe('UTF-16 LE');
    expect(c.querySelector('[data-statusbar-eol]')?.textContent).toBe('CRLF');
    cleanup();
    c = renderTab({ filePath: '/w/c.txt', content: '', encoding: 'utf8bom' });
    expect(c.querySelector('[data-statusbar-encoding]')?.textContent).toBe('UTF-8 with BOM');
    cleanup();
    c = renderTab({ filePath: '/w/d.txt', content: '中', encoding: 'gbk', encodingPinned: true });
    expect(c.querySelector('[data-statusbar-encoding]')?.textContent).toBe('GBK');
  });

  it('点击编码 → 更改文件编码(第一步);点击行尾 → 更改行尾序列', () => {
    const c = renderTab({ filePath: '/w/a.txt', content: 'a\r\n' });
    const enc = c.querySelector<HTMLButtonElement>('[data-statusbar-encoding]')!;
    expect(enc.title).toBe('Select Encoding');
    act(() => fireEvent.click(enc));
    expect(useEncodingPickerStore.getState()).toMatchObject({ isOpen: true, request: { kind: 'action', tabId: '/w/a.txt' } });
    act(() => useEncodingPickerStore.getState().close());
    act(() => fireEvent.click(c.querySelector('[data-statusbar-eol]')!));
    expect(useEncodingPickerStore.getState()).toMatchObject({
      isOpen: true,
      request: { kind: 'eol', tabId: '/w/a.txt' },
      selectedIndex: 1,
    });
  });

  it('图片 tab 不显示编码 / 行尾', () => {
    const c = renderTab({ filePath: '/w/p.png', content: '1:2:3' });
    expect(c.querySelector('[data-statusbar-encoding]')).toBeNull();
    expect(c.querySelector('[data-statusbar-eol]')).toBeNull();
  });
});
