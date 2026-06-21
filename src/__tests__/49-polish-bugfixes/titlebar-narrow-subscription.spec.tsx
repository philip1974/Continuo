// @vitest-environment jsdom
// 打磨 R22(codex 性能):TitleBar 只订阅派生 primitive(active tab 有无 /
// filePath / dirty),不再订阅整份 tabs。用户编辑 content 时 tabs[].content 变,
// 但标题文本不变 → TitleBar 不应重渲(用 Profiler 计 commit 次数验证)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Profiler } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { TitleBar } from '../../shell/TitleBar';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';

function seedTab(content: string, dirty = false): void {
  useEditorStore.setState({
    tabs: [
      {
        id: '/x.md',
        filePath: '/x.md',
        content,
        originalContent: content,
        dirty,
      },
    ],
    activeTabId: '/x.md',
  });
}

beforeEach(() => {
  useWorkspaceStore.setState({ root: '/work', recentRoots: [] });
  useEditorStore.setState({ tabs: [], activeTabId: null });
});
afterEach(() => cleanup());

describe('打磨 R22 — TitleBar 窄订阅', () => {
  it('content-only 变化 → 不触发 TitleBar 重渲(commit 次数不变)', () => {
    seedTab('hello');
    const onRender = vi.fn();
    render(
      <Profiler id="tb" onRender={onRender}>
        <TitleBar />
      </Profiler>,
    );
    const base = onRender.mock.calls.length;
    expect(base).toBeGreaterThan(0);

    // 模拟 keystroke:只改 content(+ originalContent 保持 dirty 不变)
    act(() => {
      useEditorStore.setState((s) => ({
        tabs: s.tabs.map((tb) =>
          tb.id === '/x.md' ? { ...tb, content: 'hello world typed' } : tb,
        ),
      }));
    });

    expect(onRender.mock.calls.length).toBe(base); // 无新 commit
  });

  it('dirty 变化 → 触发重渲 + 标题加 ●', () => {
    seedTab('hello', false);
    const onRender = vi.fn();
    const { container } = render(
      <Profiler id="tb" onRender={onRender}>
        <TitleBar />
      </Profiler>,
    );
    const base = onRender.mock.calls.length;
    expect(container.textContent).not.toContain('●');

    act(() => {
      useEditorStore.setState((s) => ({
        tabs: s.tabs.map((tb) =>
          tb.id === '/x.md' ? { ...tb, dirty: true } : tb,
        ),
      }));
    });

    expect(onRender.mock.calls.length).toBeGreaterThan(base);
    expect(container.textContent).toContain('●');
  });

  it('标题含 active basename + workspace 名', () => {
    seedTab('x');
    const { container } = render(<TitleBar />);
    expect(container.textContent).toContain('x.md');
    expect(container.textContent).toContain('work');
  });
});
