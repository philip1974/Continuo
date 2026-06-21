// @vitest-environment jsdom
// 打磨 R1(codex 性能):StatusBar 行/词/字符统计应按 active 内容 memo 化。
// lineCount/wordCount 全文扫描并分配中间数组;StatusBar 订阅 sessions /
// MCP 复制态 / 插件 status item 等多源,无关变化触发重渲染时不应重扫整篇。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

const { lineCountSpy, wordCountSpy, charCountSpy } = vi.hoisted(() => ({
  lineCountSpy: vi.fn((s: string) => (s.match(/\n/g)?.length ?? 0) + 1),
  wordCountSpy: vi.fn((s: string) => s.trim().split(/\s+/).filter(Boolean).length),
  charCountSpy: vi.fn((s: string) => s.length),
}));
vi.mock('../../lib/text-stats', () => ({
  lineCount: lineCountSpy,
  wordCount: wordCountSpy,
  charCount: charCountSpy,
}));

vi.mock('../../plugins/sandbox-sweep', () => ({
  getCachedFetch: () => globalThis.fetch,
  getCachedClipboard: () => ({
    readText: () => Promise.resolve(''),
    writeText: vi.fn().mockResolvedValue(undefined),
  }),
  sandboxSweep: () => {},
}));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { StatusBar } from '../../shell/StatusBar';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { useTerminalStore } from '../../stores/terminal.store';
import { _resetAgentAuthForTest } from '../../stores/agent-auth.store';
import { coApp } from '../../plugins/co-app';
import { StatusBarRegistry } from '../../plugins/registries/StatusBarRegistry';

function installApi(): void {
  Object.defineProperty(window, 'api', {
    value: {},
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

const BIG = Array.from({ length: 500 }, (_, i) => `line ${i} word word`).join('\n');

function openTab(content: string): void {
  useEditorStore.setState({
    tabs: [
      {
        id: '/big.txt',
        filePath: '/big.txt',
        content,
        originalContent: content,
        dirty: false,
      },
    ],
    activeTabId: '/big.txt',
  });
}

beforeEach(() => {
  _resetLmApiForTest();
  _resetAgentAuthForTest();
  useEditorStore.setState({ tabs: [], activeTabId: null });
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: 280 });
  useTerminalStore.setState({ sessions: [], activeId: null });
  (coApp as { statusBar: StatusBarRegistry }).statusBar = new StatusBarRegistry();
  lineCountSpy.mockClear();
  wordCountSpy.mockClear();
  charCountSpy.mockClear();
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('打磨 R1 — StatusBar 文本统计 memo 化', () => {
  it('无关 store 变化触发重渲染时不重扫文本(memo 命中)', () => {
    installApi();
    openTab(BIG);
    render(<StatusBar />);

    const baseLine = lineCountSpy.mock.calls.length;
    const baseWord = wordCountSpy.mock.calls.length;
    expect(baseLine).toBeGreaterThan(0); // 首渲染算过

    // 无关变化:新增 agent 终端 session。StatusBar 订阅 sessions → 重渲染,
    // 但 active 内容未变,统计应命中缓存不重算。
    act(() => {
      useTerminalStore.setState({
        sessions: [
          {
            id: 't1',
            title: 'codex',
            cwd: '/',
            originHint: 'agent',
            createdAt: 0,
            exitCode: null,
            ownerWindowId: 1,
          },
        ],
        activeId: 't1',
      });
    });

    expect(lineCountSpy.mock.calls.length).toBe(baseLine);
    expect(wordCountSpy.mock.calls.length).toBe(baseWord);
  });

  it('active 内容变化时重算统计(memo 失效)', () => {
    installApi();
    openTab(BIG);
    render(<StatusBar />);

    const baseLine = lineCountSpy.mock.calls.length;

    act(() => {
      openTab(BIG + '\nnew tail line');
    });

    expect(lineCountSpy.mock.calls.length).toBeGreaterThan(baseLine);
  });
});
