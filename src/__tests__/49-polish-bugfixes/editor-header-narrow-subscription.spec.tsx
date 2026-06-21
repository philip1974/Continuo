// @vitest-environment jsdom
// 打磨 R23(codex 性能):EditorHeader 只订阅 tab chrome(id/filePath/dirty)的
// JSON 签名 + active 派生 primitive,不再订阅整份 tabs / 接完整 activeTab。用户
// 编辑正文(tabs[].content 变)时签名不变 → 顶部 tab 栏不重渲(Profiler 验证)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Profiler } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { EditorHeader } from '../../panels/Editor/EditorHeader';
import { useEditorStore } from '../../stores/editor.store';
import { coApp } from '../../plugins/co-app';
import { EditorActionRegistry } from '../../plugins/registries/EditorActionRegistry';

function seedTabs(content: string, dirty = false): void {
  useEditorStore.setState({
    tabs: [
      {
        id: '/a.md',
        filePath: '/a.md',
        content,
        originalContent: content,
        dirty,
      },
    ],
    activeTabId: '/a.md',
    mode: 'source', // 避免 markdown unsafe 路径影响 effectiveMode
  });
}

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'source' });
  (coApp as { editorActions: EditorActionRegistry }).editorActions =
    new EditorActionRegistry();
});
afterEach(() => cleanup());

describe('打磨 R23 — EditorHeader 窄订阅', () => {
  it('content-only 变化 → EditorHeader 不重渲(commit 次数不变)', () => {
    seedTabs('hello', true); // dirty 已 true,后续只改 content
    const onRender = vi.fn();
    render(
      <Profiler id="eh" onRender={onRender}>
        <EditorHeader onCloseRequest={vi.fn()} />
      </Profiler>,
    );
    const base = onRender.mock.calls.length;
    expect(base).toBeGreaterThan(0);

    // 真实 keystroke:已脏 tab 持续输入(dirty 恒 true、非 markdown unsafe)→ chromeVersion
    // 不 bump → EditorHeader chrome + action selector 均 O(1) 跳过,不重渲。
    act(() => {
      useEditorStore.getState().updateContent('/a.md', 'hello more text');
    });

    expect(onRender.mock.calls.length).toBe(base); // 无新 commit
  });

  it('dirty 变化 → 触发重渲', () => {
    seedTabs('hello', false);
    const onRender = vi.fn();
    render(
      <Profiler id="eh" onRender={onRender}>
        <EditorHeader onCloseRequest={vi.fn()} />
      </Profiler>,
    );
    const base = onRender.mock.calls.length;

    // 真实 keystroke 使 tab 变脏(clean→dirty 翻转 → bump chromeVersion → 重渲)。
    // perf P12/P14 后 header 订阅 chromeVersion 而非 tabs 内容,须走 action 而非 raw setState。
    act(() => {
      useEditorStore.getState().updateContent('/a.md', 'hello edited');
    });

    expect(onRender.mock.calls.length).toBeGreaterThan(base);
  });

  it('新增 tab → 触发重渲 + 列出新 basename', () => {
    seedTabs('x', false);
    const { container } = render(<EditorHeader onCloseRequest={vi.fn()} />);
    expect(container.textContent).not.toContain('b.md');
    // 经真实 openTab action 新增(生产唯一路径)→ bump chromeVersion → header 重渲。
    // perf P12 后 header 订阅 chromeVersion 而非 tabs 内容,故须走 action 而非 raw setState。
    act(() => {
      useEditorStore.getState().openTab({
        id: '/b.md',
        filePath: '/b.md',
        content: '',
        originalContent: '',
        dirty: false,
      });
    });
    expect(container.textContent).toContain('b.md');
  });
});
