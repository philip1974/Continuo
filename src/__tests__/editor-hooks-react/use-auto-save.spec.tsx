// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useEffect } from 'react';
import { render, cleanup, act } from '@testing-library/react';
import {
  useAutoSave,
  isAutoSaveEnabled,
} from '../../panels/Editor/useAutoSave';
import { useEditorStore } from '../../stores/editor.store';
import {
  flushPendingAutoSave,
} from '../../panels/Editor/autosave-flush-registry';

function Probe({
  saveFile,
  enabled,
  delayMs,
}: {
  saveFile: (tabId: string) => Promise<unknown>;
  enabled: boolean;
  delayMs?: number;
}) {
  useAutoSave(saveFile, { enabled, delayMs: delayMs ?? 2000 });
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

// 已保存(不再脏)的 tab 不重复写盘:Cmd+S 在防抖窗口内保存成功后,已排队的 autosave 计时器 / 切 tab flush /
// 关窗 flush 不应再做一次读盘比较 + 原子写(外部修改时干净 tab 还会误报「自动保存失败」)。
describe('useAutoSave · 已干净的 tab 不重复写盘', () => {
  const dirtyTab = (id: string, content = 'new') => ({
    id,
    filePath: id,
    content,
    originalContent: 'old',
    dirty: true,
  });


  it('输入 → 防抖窗口内 Cmd+S 保存成功 → 2s 到点不再写盘', async () => {
    const saveFile = vi.fn(async () => ({ ok: true }));
    useEditorStore.setState({ tabs: [dirtyTab('/a.md')], activeTabId: '/a.md' });
    render(<Probe saveFile={saveFile} enabled={true} delayMs={2000} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    // Cmd+S 成功:markSaved 推进基线,tab 变干净
    act(() => useEditorStore.getState().markSaved('/a.md', 'new'));
    expect(vi.getTimerCount()).toBe(0); // 变干净即取消已排的计时器
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('保存后同一批更新里切走 tab → 切 tab flush 不再写已干净的旧 tab', async () => {
    const saveFile = vi.fn(async () => ({ ok: true }));
    useEditorStore.setState({
      tabs: [dirtyTab('/a.md'), { ...dirtyTab('/b.md', 'old'), dirty: false }],
      activeTabId: '/a.md',
    });
    render(<Probe saveFile={saveFile} enabled={true} delayMs={2000} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await act(async () => {
      useEditorStore.getState().markSaved('/a.md', 'new');
      useEditorStore.getState().switchTab('/b.md');
    });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('保存后尚未重渲即关窗 flush → 不再写已干净的 tab', async () => {
    const saveFile = vi.fn(async () => ({ ok: true }));
    useEditorStore.setState({ tabs: [dirtyTab('/a.md')], activeTabId: '/a.md' });
    render(<Probe saveFile={saveFile} enabled={true} delayMs={2000} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    // 关窗「保存」:先显式保存(store 变干净),紧接着 flushPendingAutoSave,中间没有 React 重渲
    useEditorStore.getState().markSaved('/a.md', 'new');
    await flushPendingAutoSave();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('Cmd+S 保存后继续输入(仍脏)→ 照常 autosave', async () => {
    const saveFile = vi.fn(async () => ({ ok: true }));
    useEditorStore.setState({ tabs: [dirtyTab('/a.md')], activeTabId: '/a.md' });
    render(<Probe saveFile={saveFile} enabled={true} delayMs={2000} />);
    act(() => useEditorStore.getState().markSaved('/a.md', 'new'));
    act(() => useEditorStore.getState().updateContent('/a.md', 'newer'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(saveFile).toHaveBeenCalledWith('/a.md');
  });
});

// 切 tab 时编辑器卸载回写(Milkdown 200ms 防抖窗口内的输入)发生在 useAutoSave 的 cleanup 之前:React 先执行
// 被删子树的 passive destroy,再执行面板自身 effect 的 destroy。回写把旧 tab 写脏,但计时器里没有它的任务 →
// cleanup 须先补排队再 flush,否则旧 tab 留在内存脏态不自动保存。
describe('useAutoSave · 切 tab 时卸载回写的编辑也落盘', () => {
  function EditorStub({ id, typed }: { id: string; typed: string | null }) {
    useEffect(
      () => () => {
        if (typed !== null) useEditorStore.getState().updateContent(id, typed);
      },
      [id, typed],
    );
    return null;
  }
  function Panel({
    saveFile,
    typed,
  }: {
    saveFile: (tabId: string) => Promise<unknown>;
    typed: string | null;
  }) {
    const active = useEditorStore((s) => s.activeTabId);
    useAutoSave(saveFile, { enabled: isAutoSaveEnabled(active), delayMs: 2000 });
    return active === null ? null : <EditorStub key={active} id={active} typed={typed} />;
  }
  const clean = (id: string) => ({
    id,
    filePath: id,
    content: 'c',
    originalContent: 'c',
    dirty: false,
  });


  it('干净 .md tab 切走时卸载回写变脏 → 切 tab flush 仍按旧 tab 落盘', async () => {
    const saveFile = vi.fn(async () => ({ ok: true }));
    useEditorStore.setState({ tabs: [clean('/a.md'), clean('/b.md')], activeTabId: '/a.md' });
    render(<Panel saveFile={saveFile} typed="c typed" />);
    await act(async () => {
      useEditorStore.getState().switchTab('/b.md');
    });
    expect(saveFile).toHaveBeenCalledWith('/a.md');
  });

  it('切到不自动保存的代码文件时同样落盘(按旧 tab 的 autosave 开关判断)', async () => {
    const saveFile = vi.fn(async () => ({ ok: true }));
    useEditorStore.setState({ tabs: [clean('/a.md'), clean('/b.ts')], activeTabId: '/a.md' });
    render(<Panel saveFile={saveFile} typed="c typed" />);
    await act(async () => {
      useEditorStore.getState().switchTab('/b.ts');
    });
    expect(saveFile).toHaveBeenCalledWith('/a.md');
  });

  it('旧 tab 不自动保存(代码文件)→ 卸载回写后切走不落盘', async () => {
    const saveFile = vi.fn(async () => ({ ok: true }));
    useEditorStore.setState({ tabs: [clean('/a.ts'), clean('/b.md')], activeTabId: '/a.ts' });
    render(<Panel saveFile={saveFile} typed="c typed" />);
    await act(async () => {
      useEditorStore.getState().switchTab('/b.md');
    });
    expect(saveFile).not.toHaveBeenCalled();
  });
});
