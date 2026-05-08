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
  saveFile: () => Promise<unknown>;
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

  it('卸载时 cancel pending schedule', async () => {
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
      await vi.advanceTimersByTimeAsync(50);
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(saveFile).not.toHaveBeenCalled();
  });
});
