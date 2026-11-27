// @vitest-environment jsdom
// BDD: statusbar-item-hit-area —— 状态栏可点击项占满栏高、左右留白、悬停底色。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { StatusBar, STATUS_ITEM_BUTTON_CLASS } from '../../shell/StatusBar';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useAgentAuthStore } from '../../stores/agent-auth.store';
import { setTabIndentation, useIndentationStore } from '../../panels/Editor/editor-indentation';
import { setEditorSelectionStatus } from '../../panels/Editor/editor-selection-status';
import { setLocale } from '../../i18n';

beforeEach(() => {
  _resetLmApiForTest();
  Object.defineProperty(window, 'api', { value: {}, writable: true, configurable: true });
  captureLmApi();
  setLocale('en');
  useWorkspaceStore.setState({ root: '/w', recentRoots: [] });
  useIndentationStore.setState({ byTab: new Map() });
  useEditorStore.setState({
    tabs: [{ id: '/w/a.ts', filePath: '/w/a.ts', content: 'x', originalContent: 'x', dirty: false }],
    activeTabId: '/w/a.ts',
    mode: 'source',
  });
  setTabIndentation('/w/a.ts', { tabSize: 4, insertSpaces: true });
  setEditorSelectionStatus('/w/a.ts', useEditorStore.getState().activeGroupId, { line: 1, col: 1, selections: 1, chars: 0 });
  useAgentAuthStore.setState({ sessionGranted: true });
});
afterEach(() => {
  cleanup();
  delete (window as { api?: unknown }).api;
});

const BOX = ['self-stretch', 'px-1.5', 'flex', 'items-center'];

describe('状态栏可点击项', () => {
  it('所有按钮:占满栏高 + 左右留白 + 悬停底色(语义 token)+ 内嵌焦点环', () => {
    const { container } = render(<StatusBar />);
    const buttons = [...container.querySelectorAll('footer button')];
    // 光标位置 / 缩进 / 编码 / 行尾 / MCP 复制 / agent 撤销
    expect(buttons.length).toBe(6);
    for (const b of buttons) {
      const cls = b.className.split(/\s+/);
      for (const c of [...BOX, 'hover:bg-hover', 'focus-visible:-outline-offset-1']) expect(cls, b.outerHTML).toContain(c);
    }
    for (const c of ['hover:bg-hover', 'self-stretch', 'px-1.5']) expect(STATUS_ITEM_BUTTON_CLASS).toContain(c);
  });

  it('不可点击项(工作区名 / 文件名)留白、无悬停底色', () => {
    const { container } = render(<StatusBar />);
    const spans = [...container.querySelectorAll('footer span[title]')];
    expect(spans.length).toBeGreaterThanOrEqual(2);
    for (const s of spans) {
      expect(s.className).toContain('px-1.5');
      expect(s.className).not.toContain('hover:bg-hover');
    }
  });
});
