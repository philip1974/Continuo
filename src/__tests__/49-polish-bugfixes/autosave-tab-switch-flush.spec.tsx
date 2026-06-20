// @vitest-environment jsdom
// topic 49 第七轮 · P1-S:切走/卸载 markdown tab 时 flush 待执行的自动保存。
//
// 根因:旧 useAutoSave 把保存绑定到"当前 active tab"(saveActive),并在 effect
// cleanup 里 cancel pending。用户在 markdown tab A 连续输入(防抖每次按键重置 →
// 保存从未触发),2s 内切到 tab B 时,cleanup cancel 掉 A 的 pending → A 的整段
// 编辑静默丢失(editor content 不持久化,关窗即没)。
//
// 修复:每个 tab 一个 scheduler(绑定调度时捕获的 tabId),切走该 tab(scheduler
// 身份随 tabId 变)或卸载时 flush(而非 cancel)→ 用捕获的 tabId 立即落盘。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useAutoSave } from '../../panels/Editor/useAutoSave';
import { useEditorStore } from '../../stores/editor.store';

function Probe({
  saveTab,
  delayMs,
}: {
  saveTab: (tabId: string) => Promise<unknown>;
  delayMs: number;
}) {
  useAutoSave(saveTab, { enabled: true, delayMs });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  useEditorStore.setState({ tabs: [], activeTabId: null });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('topic49 P1-S · 切 markdown tab 不丢自动保存', () => {
  it('连续输入后立即切走 tab A → flush A 的 pending(按 A 的 id 保存)', async () => {
    const saveTab = vi.fn(async () => true);
    useEditorStore.setState({
      tabs: [
        { id: '/a.md', filePath: '/a.md', content: 'a-new', originalContent: 'a-old', dirty: true },
        { id: '/b.md', filePath: '/b.md', content: 'b', originalContent: 'b', dirty: false },
      ],
      activeTabId: '/a.md',
    });

    render(<Probe saveTab={saveTab} delayMs={2000} />);
    // 还在防抖窗口内,保存未触发
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(saveTab).not.toHaveBeenCalled();

    // 切到 tab B(模拟用户切 tab):active 变 B
    await act(async () => {
      useEditorStore.setState({ activeTabId: '/b.md' });
    });

    // 离开 A 时 flush → 用 A 的 id 立即保存,不丢编辑
    expect(saveTab).toHaveBeenCalledWith('/a.md');
    expect(saveTab).toHaveBeenCalledTimes(1);
  });

  it('保存的是被切走的 tab(A),不是新 active 的 tab(B)', async () => {
    const saveTab = vi.fn(async () => true);
    useEditorStore.setState({
      tabs: [
        { id: '/a.md', filePath: '/a.md', content: 'a', originalContent: 'a0', dirty: true },
        { id: '/b.md', filePath: '/b.md', content: 'b', originalContent: 'b0', dirty: true },
      ],
      activeTabId: '/a.md',
    });
    render(<Probe saveTab={saveTab} delayMs={2000} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await act(async () => {
      useEditorStore.setState({ activeTabId: '/b.md' });
    });
    // 关键:flush 用捕获的 A id,不能因为 active 已变 B 就保存了 B
    expect(saveTab).toHaveBeenCalledWith('/a.md');
    expect(saveTab).not.toHaveBeenCalledWith('/b.md');
  });

  it('正常 2s 到点仍按当前 tab id 保存一次(回归)', async () => {
    const saveTab = vi.fn(async () => true);
    useEditorStore.setState({
      tabs: [
        { id: '/a.md', filePath: '/a.md', content: 'a', originalContent: 'a0', dirty: true },
      ],
      activeTabId: '/a.md',
    });
    render(<Probe saveTab={saveTab} delayMs={100} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(saveTab).toHaveBeenCalledWith('/a.md');
    expect(saveTab).toHaveBeenCalledTimes(1);
  });
});
