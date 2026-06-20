// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import {
  useAutoSave,
  isAutoSaveEnabled,
} from '../../panels/Editor/useAutoSave';
import { useEditorStore } from '../../stores/editor.store';

function Probe({
  saveFile,
  enabled,
  delayMs,
}: {
  saveFile: (tabId: string) => Promise<unknown>;
  enabled: boolean;
  delayMs?: number;
}) {
  useAutoSave(saveFile, { enabled, delayMs });
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

describe('isAutoSaveEnabled', () => {
  it('null → false', () => {
    expect(isAutoSaveEnabled(null)).toBe(false);
  });

  it('.md / .markdown / .MD → true', () => {
    expect(isAutoSaveEnabled('a.md')).toBe(true);
    expect(isAutoSaveEnabled('/x/a.markdown')).toBe(true);
    expect(isAutoSaveEnabled('A.MD')).toBe(true);
  });

  it('其它扩展 → false', () => {
    expect(isAutoSaveEnabled('a.txt')).toBe(false);
    expect(isAutoSaveEnabled('a.tsx')).toBe(false);
    expect(isAutoSaveEnabled('Makefile')).toBe(false);
  });
});

describe('useAutoSave', () => {
  it('enabled=false → 不触发 saveFile', async () => {
    const saveFile = vi.fn(async () => true);
    useEditorStore.setState({
      tabs: [
        {
          id: '/a.md',
          filePath: '/a.md',
          content: 'x',
          originalContent: 'y',
          dirty: true,
        },
      ],
      activeTabId: '/a.md',
    });

    render(<Probe saveFile={saveFile} enabled={false} delayMs={50} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('无 active tab → 不触发', async () => {
    const saveFile = vi.fn(async () => true);
    render(<Probe saveFile={saveFile} enabled={true} delayMs={50} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('filePath=null(草稿) → 不触发', async () => {
    const saveFile = vi.fn(async () => true);
    useEditorStore.setState({
      tabs: [
        {
          id: 'untitled-1',
          filePath: null,
          content: 'x',
          originalContent: '',
          dirty: true,
        },
      ],
      activeTabId: 'untitled-1',
    });
    render(<Probe saveFile={saveFile} enabled={true} delayMs={50} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('dirty=false → 不触发', async () => {
    const saveFile = vi.fn(async () => true);
    useEditorStore.setState({
      tabs: [
        {
          id: '/a.md',
          filePath: '/a.md',
          content: 'same',
          originalContent: 'same',
          dirty: false,
        },
      ],
      activeTabId: '/a.md',
    });
    render(<Probe saveFile={saveFile} enabled={true} delayMs={50} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('enabled + dirty + filePath → delayMs 后触发一次', async () => {
    const saveFile = vi.fn(async () => true);
    useEditorStore.setState({
      tabs: [
        {
          id: '/a.md',
          filePath: '/a.md',
          content: 'new',
          originalContent: 'old',
          dirty: true,
        },
      ],
      activeTabId: '/a.md',
    });

    render(<Probe saveFile={saveFile} enabled={true} delayMs={100} />);
    expect(saveFile).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(110);
    });
    expect(saveFile).toHaveBeenCalledTimes(1);
  });

  it('运行中关掉 autosave(enabled→false)→ 取消已排队的保存', async () => {
    // topic49 第十一轮:flush 改造后补回"禁用 autosave 取消 pending"契约。
    const saveFile = vi.fn(async () => true);
    useEditorStore.setState({
      tabs: [
        {
          id: '/a.md',
          filePath: '/a.md',
          content: 'new',
          originalContent: 'old',
          dirty: true,
        },
      ],
      activeTabId: '/a.md',
    });
    const { rerender } = render(
      <Probe saveFile={saveFile} enabled={true} delayMs={200} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50); // 防抖窗口内,未触发
    });
    // 用户关掉 markdown autosave 设置
    rerender(<Probe saveFile={saveFile} enabled={false} delayMs={200} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // 已排队的保存被取消,不写盘
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('卸载时 flush pending schedule(落盘,不丢编辑)', async () => {
    // 行为变更(topic 49 第七轮):旧实现卸载 cancel → 防抖窗口内的编辑丢失。
    // 现在卸载 flush → pending 的保存立即执行,且按捕获的 tabId 保存。
    const saveFile = vi.fn(async () => true);
    useEditorStore.setState({
      tabs: [
        {
          id: '/a.md',
          filePath: '/a.md',
          content: 'new',
          originalContent: 'old',
          dirty: true,
        },
      ],
      activeTabId: '/a.md',
    });

    const { unmount } = render(
      <Probe saveFile={saveFile} enabled={true} delayMs={200} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50); // 仍在防抖窗口内(<200)
    });
    expect(saveFile).not.toHaveBeenCalled();
    await act(async () => {
      unmount();
    });
    // 卸载即 flush → 立即保存,且保存的是捕获的 tabId
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(saveFile).toHaveBeenCalledWith('/a.md');
  });
});
