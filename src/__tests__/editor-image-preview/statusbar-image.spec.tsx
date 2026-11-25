// @vitest-environment jsdom
// 图片 tab 的内容只是 stat 指纹:状态栏不显示行 / 词 / 字符统计(尺寸 / 大小在图片视图角落显示)。行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { StatusBar } from '../../shell/StatusBar';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { setLocale } from '../../i18n';

function footerText(path: string): string {
  const content = '1.5:2048:7';
  useEditorStore.setState({
    tabs: [{ id: path, filePath: path, content, originalContent: content, dirty: false }],
    activeTabId: path,
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
});

describe('状态栏:图片 tab', () => {
  it('显示文件名,不显示行 / 词 / 字符统计;文本 tab 照常显示', () => {
    const img = footerText('/w/a.png');
    expect(img).toContain('a.png');
    expect(img).not.toMatch(/\bline/);
    cleanup();
    expect(footerText('/w/a.txt')).toContain('1 line');
  });
});
