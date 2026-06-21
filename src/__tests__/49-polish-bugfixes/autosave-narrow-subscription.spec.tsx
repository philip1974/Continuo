// @vitest-environment jsdom
// 打磨 R47(codex 性能):useAutoSave 改为 useShallow 窄订阅 active tab 的调度字段
// {id,filePath,dirty,content}。markSaved 推进 originalContent、reloadFromDisk 改
// reloadEpoch 等非调度字段变化不再触发 hook 重渲/effect 重跑(=不重排防抖)。
//
// 验证:debounce 窗口中途改 reloadEpoch(非调度字段)。窄订阅下 effect 不重跑 →
// 防抖不被重置 → save 仍在原定时刻触发。(整对象订阅会重排 → save 推迟。)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useAutoSave } from '../../panels/Editor/useAutoSave';
import { useEditorStore } from '../../stores/editor.store';

function Probe({ saveFile, delayMs }: { saveFile: (id: string) => Promise<unknown>; delayMs: number }) {
  useAutoSave(saveFile, { enabled: true, delayMs });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  useEditorStore.setState({
    tabs: [
      { id: '/a.md', filePath: '/a.md', content: 'edited', originalContent: 'orig', dirty: true },
    ],
    activeTabId: '/a.md',
  });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('打磨 R47 — useAutoSave 窄订阅不被非调度字段重排', () => {
  it('debounce 中途改 reloadEpoch → 不重排,save 仍在原时刻触发', async () => {
    const saveFile = vi.fn(async () => true);
    render(<Probe saveFile={saveFile} delayMs={100} />);

    // 推进到 debounce 窗口中途(< 100)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(saveFile).not.toHaveBeenCalled();

    // 改非调度字段 reloadEpoch(window 等外部 reload 会改它)
    act(() => {
      useEditorStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === '/a.md' ? { ...t, reloadEpoch: (t.reloadEpoch ?? 0) + 1 } : t,
        ),
      }));
    });

    // 再推进 40(累计 120 > 100):窄订阅下原 debounce 已触发
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(saveFile).toHaveBeenCalledWith('/a.md');
  });
});
