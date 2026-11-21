// @vitest-environment jsdom
// 打磨 R1(性能):StatusBar 行/词/字符统计应按 active 内容 memo 化。
// lineCount/wordCount 全文扫描并分配中间数组;StatusBar 订阅 sessions /
// MCP 复制态 / 插件 status item 等多源,无关变化触发重渲染时不应重扫整篇。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Profiler } from 'react';
import { render, cleanup, act, screen } from '@testing-library/react';

// perf P7:StatusBar 改用单遍 computeTextStats(替代 lineCount/wordCount/charCount
// 三次调用)。memo 行为契约不变 —— spy computeTextStats 验命中/失效。
const { computeTextStatsSpy } = vi.hoisted(() => ({
  computeTextStatsSpy: vi.fn((s: string) => ({
    lines: s.length === 0 ? 0 : (s.match(/\n/g)?.length ?? 0) + 1,
    words: s.trim() === '' ? 0 : s.trim().split(/\s+/).length,
    chars: s.length,
  })),
}));
vi.mock('../../lib/text-stats', () => ({
  computeTextStats: computeTextStatsSpy,
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
  useTerminalStore.setState({ sessions: [] });
  (coApp as { statusBar: StatusBarRegistry }).statusBar = new StatusBarRegistry();
  computeTextStatsSpy.mockClear();
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

    const baseCalls = computeTextStatsSpy.mock.calls.length;
    expect(baseCalls).toBeGreaterThan(0); // 首渲染算过

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
      });
    });

    expect(computeTextStatsSpy.mock.calls.length).toBe(baseCalls);
  });

  it('active 内容变化时重算统计(memo 失效)', () => {
    installApi();
    openTab(BIG);
    render(<StatusBar />);

    const baseCalls = computeTextStatsSpy.mock.calls.length;

    act(() => {
      openTab(BIG + '\nnew tail line');
    });

    expect(computeTextStatsSpy.mock.calls.length).toBeGreaterThan(baseCalls);
  });
});

// perf:内容变化时 computeTextStats 全文 O(N) 扫描不应压在高优先级渲染上(每键一次)。activeContent 经
// useDeferredValue 后再算:高优先级渲染先用旧值(memo 命中)提交,统计在随后的低优先级渲染里更新(延后一帧)。
describe('StatusBar 文本统计延后到低优先级渲染(useDeferredValue)', () => {
  it('内容变化:高优先级提交不重算(仍显示旧字符数),随后低优先级渲染重算,最终统计正确', () => {
    installApi();
    openTab(BIG);
    const events: string[] = [];
    computeTextStatsSpy.mockImplementation((s: string) => {
      events.push(`compute:${s.length}`);
      return {
        lines: s.length === 0 ? 0 : (s.match(/\n/g)?.length ?? 0) + 1,
        words: s.trim() === '' ? 0 : s.trim().split(/\s+/).length,
        chars: s.length,
      };
    });
    const footerText = () => screen.getByRole('contentinfo').textContent ?? '';
    render(
      <Profiler
        id="sb"
        onRender={() => {
          events.push(`commit:${footerText()}`);
        }}
      >
        <StatusBar />
      </Profiler>,
    );
    expect(footerText()).toContain(String(BIG.length));

    const next = BIG + '\nnew tail line';
    events.length = 0;
    act(() => {
      openTab(next);
    });

    const firstCompute = events.indexOf(`compute:${next.length}`);
    expect(firstCompute).toBeGreaterThan(0);
    // 新内容的统计计算之前已有一次提交,且那次提交仍显示旧字符数
    const before = events.slice(0, firstCompute).filter((e) => e.startsWith('commit:'));
    expect(before.length).toBeGreaterThan(0);
    expect(before[0]).toContain(String(BIG.length));
    expect(before[0]).not.toContain(String(next.length));
    // 最终值更新(e2e save-shortcut 依赖 footer 字符数变化)
    expect(footerText()).toContain(String(next.length));
    expect(computeTextStatsSpy.mock.calls.filter((c) => c[0] === next)).toHaveLength(1);
  });

  it('延后统计只重渲统计子组件:内容变化时父级(含插件 status item render)仍只渲染一次', () => {
    installApi();
    openTab(BIG);
    const pluginRender = vi.fn(() => 'plugin-item');
    coApp.statusBar.register({ id: 'p', side: 'left', render: pluginRender });
    render(<StatusBar />);
    const base = pluginRender.mock.calls.length;

    act(() => {
      openTab(BIG + '\nnew tail line');
    });

    expect(screen.getByRole('contentinfo').textContent).toContain(String((BIG + '\nnew tail line').length));
    // 同步统计(不延后)时本测试的 setState 触发 2 次父级渲染;延后统计不得再额外重渲父级
    // (统计留在父级里 useDeferredValue 时为 3:延后渲染重跑整条状态栏与所有插件 render)。
    expect(pluginRender.mock.calls.length - base).toBeLessThanOrEqual(2);
  });

  it('切换 tab 时统计在首次提交即为新文件的值(只对同一 tab 内的编辑延后),不闪上一个文件的值', () => {
    installApi();
    const other = 'x y z';
    useEditorStore.setState({
      tabs: [
        { id: '/big.txt', filePath: '/big.txt', content: BIG, originalContent: BIG, dirty: false },
        { id: '/o.txt', filePath: '/o.txt', content: other, originalContent: other, dirty: false },
      ],
      activeTabId: '/big.txt',
    });
    const commits: string[] = [];
    const footerText = () => screen.queryByRole('contentinfo')?.textContent ?? '';
    render(
      <Profiler id="sb" onRender={() => commits.push(footerText())}>
        <StatusBar />
      </Profiler>,
    );
    expect(footerText()).toContain(String(BIG.length));
    commits.length = 0;
    act(() => {
      useEditorStore.setState({ activeTabId: '/o.txt' });
    });
    expect(commits.length).toBeGreaterThan(0);
    for (const c of commits) expect(c).not.toContain(String(BIG.length));
    expect(footerText()).toContain(String(other.length));
  });
});
