// @vitest-environment jsdom
// 状态栏行 / 词 / 字符统计按数量选单复数(en:1 line / 2 lines;zh / ko 无单复数之分)。行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { StatusBar } from '../../shell/StatusBar';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { setLocale, translateCount } from '../../i18n';
import { notifyLocaleChange } from '../../i18n/react';

function renderWith(content: string): string {
  useEditorStore.setState({
    tabs: [{ id: '/x.md', filePath: '/x.md', content, originalContent: content, dirty: false }],
    activeTabId: '/x.md',
  });
  const { container } = render(<StatusBar />);
  return container.querySelector('footer')?.textContent ?? '';
}

beforeEach(() => {
  _resetLmApiForTest();
  Object.defineProperty(window, 'api', { value: {}, writable: true, configurable: true });
  captureLmApi();
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  setLocale('en');
});
afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  act(() => {
    setLocale('en');
    notifyLocaleChange();
  });
});

describe('状态栏统计单复数', () => {
  it('en:计数为 1 用单数,其余用复数', () => {
    expect(renderWith('a')).toContain('1 line · 1 word · 1 char');
    cleanup();
    expect(renderWith('a b\nc')).toContain('2 lines · 3 words · 5 chars');
    cleanup();
    expect(renderWith('')).toContain('0 lines · 0 words · 0 chars');
  });

  it('zh / ko 不区分单复数', () => {
    act(() => {
      setLocale('zh');
      notifyLocaleChange();
    });
    expect(renderWith('a')).toContain('1 行 · 1 词 · 1 字符');
    cleanup();
    act(() => {
      setLocale('ko');
      notifyLocaleChange();
    });
    expect(renderWith('a b\nc')).toContain('2줄 · 3단어 · 5자');
  });

  it('translateCount 按当前语言的复数规则选 _one / _other,并以 {count} 插值', () => {
    setLocale('en');
    expect(translateCount('statusbar.editor_stats.lines', 1)).toBe('1 line');
    expect(translateCount('statusbar.editor_stats.lines', 0)).toBe('0 lines');
    expect(translateCount('statusbar.editor_stats.lines', 21)).toBe('21 lines');
  });
});
