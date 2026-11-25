// @vitest-environment jsdom
// BDD:tab 右键菜单(对齐 VSCode 编辑器标签右键菜单)。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

const h = vi.hoisted(() => ({ writeText: vi.fn(async (_text: string) => {}), reveal: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/plugins/sandbox-sweep', () => ({ getCachedClipboard: () => ({ writeText: h.writeText }) }));
vi.mock('@/lib/co-api', () => ({ coApi: { fs: { reveal: h.reveal } } }));

import { tabCloseTargets } from '@/lib/tab-close-targets';
import { nextBatchCloseStep } from '@/panels/Editor/tab-batch-close';
import { EditorHeader } from '@/panels/Editor/EditorHeader';
import { SharedTab } from '@/shell/motion/SharedTab';
import { closePanelsInOrder, wrapPanelClose } from '@/shell/dock/wrap-panel-close';
import { useEditorStore, type EditorTab } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { setLocale } from '@/i18n';

const items = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[role=menuitem]'));
const labels = (): string[] => items().map((el) => el.textContent ?? '');
const item = (label: string): HTMLElement => items().find((el) => el.textContent === label)!;

beforeEach(() => setLocale('en'));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('关闭目标集合(按 tab 顺序)', () => {
  const tabs = [{ id: 'a' }, { id: 'b', dirty: true }, { id: 'c' }, { id: 'd' }];
  it('关闭 / 关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭', () => {
    expect(tabCloseTargets(tabs, 'b', 'close')).toEqual(['b']);
    expect(tabCloseTargets(tabs, 'b', 'others')).toEqual(['a', 'c', 'd']);
    expect(tabCloseTargets(tabs, 'b', 'right')).toEqual(['c', 'd']);
    expect(tabCloseTargets(tabs, 'd', 'right')).toEqual([]);
    expect(tabCloseTargets(tabs, 'c', 'saved')).toEqual(['a', 'c', 'd']);
    expect(tabCloseTargets(tabs, 'a', 'all')).toEqual(['a', 'b', 'c', 'd']);
  });
  it('目标 tab 已不在列表 → 空', () => {
    expect(tabCloseTargets(tabs, 'x', 'all')).toEqual([]);
  });
});

describe('编辑器批量关闭:逐个确认脏 tab,全部确认完才关闭', () => {
  const tabs = [
    { id: 'a', filePath: '/w/a.ts', dirty: false },
    { id: 'b', filePath: '/w/b.ts', dirty: true },
    { id: 'c', filePath: '/w/c.ts', dirty: true },
  ];
  it('按顺序先确认第一个脏 tab,进度里只剩它之后的', () => {
    const step = nextBatchCloseStep(tabs, { rest: ['a', 'b', 'c'], closeIds: ['a', 'b', 'c'] });
    expect(step).toEqual({
      kind: 'confirm',
      tab: { id: 'b', filePath: '/w/b.ts', dirty: true },
      batch: { rest: ['c'], closeIds: ['a', 'b', 'c'] },
    });
    if (step.kind !== 'confirm') throw new Error('expected confirm');
    const next = nextBatchCloseStep(tabs, step.batch);
    expect(next.kind === 'confirm' && next.tab.id).toBe('c');
  });
  it('没有待确认的脏 tab → 关闭全部仍存在的目标(含已选「不保存」的脏 tab)', () => {
    expect(nextBatchCloseStep(tabs, { rest: [], closeIds: ['a', 'b', 'gone'] })).toEqual({
      kind: 'close',
      ids: ['a', 'b'],
    });
  });
  it('全是干净 tab → 直接关闭,不确认', () => {
    expect(nextBatchCloseStep(tabs, { rest: ['a'], closeIds: ['a'] })).toEqual({ kind: 'close', ids: ['a'] });
  });
});

// ── 编辑器文件 tab ───────────────────────────────────────────────────────────

function editorTab(id: string, dirty = false): EditorTab {
  return { id, filePath: id, content: '', originalContent: dirty ? 'x' : '', dirty };
}

function renderEditorHeader(onCloseTabsRequest?: (ids: readonly string[]) => void) {
  useEditorStore.setState({
    tabs: [editorTab('/w/a.ts'), editorTab('/w/src/b.ts', true), editorTab('/w/c.ts')],
    activeTabId: '/w/a.ts',
    mode: 'edit',
  });
  useWorkspaceStore.setState({ root: '/w' });
  return render(<EditorHeader onCloseRequest={vi.fn()} onCloseTabsRequest={onCloseTabsRequest} />);
}

const editorTabEl = (name: string): HTMLElement =>
  Array.from(document.querySelectorAll<HTMLElement>('[role=tab]')).find((el) => el.textContent?.startsWith(name))!;

describe('编辑器文件 tab 右键菜单', () => {
  it('右键 → VSCode 同序菜单项(关闭类 + 复制路径 / 相对路径 + 在 Finder 中显示)', () => {
    renderEditorHeader(vi.fn());
    fireEvent.contextMenu(editorTabEl('b.ts'));
    expect(labels()).toEqual([
      'Close',
      'Close Others',
      'Close to the Right',
      'Close Saved',
      'Close All',
      'Copy Path',
      'Copy Relative Path',
      'Reveal in Finder',
    ]);
    for (const el of items()) expect(el.classList.contains('wm-menu-item')).toBe(true);
  });

  it.each([
    ['Close', ['/w/src/b.ts']],
    ['Close Others', ['/w/a.ts', '/w/c.ts']],
    ['Close to the Right', ['/w/c.ts']],
    ['Close Saved', ['/w/a.ts', '/w/c.ts']],
    ['Close All', ['/w/a.ts', '/w/src/b.ts', '/w/c.ts']],
  ])('%s → 按 tab 顺序请求关闭对应 tab', (label, ids) => {
    const onCloseTabsRequest = vi.fn();
    renderEditorHeader(onCloseTabsRequest);
    fireEvent.contextMenu(editorTabEl('b.ts'));
    fireEvent.click(item(label));
    expect(onCloseTabsRequest).toHaveBeenCalledWith(ids);
  });

  it('最右 tab:「关闭右侧」禁用;复制路径 / 相对路径 / 在 Finder 中显示', async () => {
    renderEditorHeader(vi.fn());
    fireEvent.contextMenu(editorTabEl('c.ts'));
    expect(item('Close to the Right').hasAttribute('disabled')).toBe(true);
    fireEvent.click(item('Copy Path'));
    fireEvent.contextMenu(editorTabEl('b.ts'));
    fireEvent.click(item('Copy Relative Path'));
    fireEvent.contextMenu(editorTabEl('b.ts'));
    fireEvent.click(item('Reveal in Finder'));
    await act(async () => {});
    expect(h.writeText.mock.calls.map((c) => c[0])).toEqual(['/w/c.ts', 'src/b.ts']);
    expect(h.reveal).toHaveBeenCalledWith('/w/src/b.ts');
  });

  it('键盘:tab 聚焦时 Shift+F10 / 菜单键打开菜单', () => {
    renderEditorHeader(vi.fn());
    fireEvent.keyDown(editorTabEl('a.ts'), { key: 'F10', shiftKey: true });
    expect(labels()).toContain('Close All');
    cleanup();
    renderEditorHeader(vi.fn());
    fireEvent.keyDown(editorTabEl('a.ts'), { key: 'ContextMenu' });
    expect(labels()).toContain('Close All');
  });

  it('未提供批量关闭回调 → 无右键菜单', () => {
    renderEditorHeader(undefined);
    fireEvent.contextMenu(editorTabEl('a.ts'));
    expect(items()).toHaveLength(0);
  });
});

// ── dock 面板 tab ────────────────────────────────────────────────────────────

interface FakePanel {
  id: string;
  api: { id: string; close: ReturnType<typeof vi.fn> };
}

function renderDockTab(targetId: string, ids: readonly string[]) {
  const panels: FakePanel[] = ids.map((id) => ({ id, api: { id, close: vi.fn() } }));
  const api = {
    id: targetId,
    title: targetId,
    isActive: true,
    group: { id: 'g1', api: { isMaximized: () => false }, panels },
    close: panels.find((p) => p.id === targetId)!.api.close,
    setActive: vi.fn(),
    onDidActiveChange: () => ({ dispose: vi.fn() }),
    onDidTitleChange: () => ({ dispose: vi.fn() }),
    onDidGroupChange: () => ({ dispose: vi.fn() }),
  };
  const props = {
    api,
    containerApi: { onDidMaximizedGroupChange: () => ({ dispose: vi.fn() }), exitMaximizedGroup: vi.fn() },
    params: {},
  } as unknown as Parameters<typeof SharedTab>[0];
  const r = render(<SharedTab {...props} />);
  return { panels, tab: r.getByRole('tab') };
}

describe('dock 面板 tab 右键菜单', () => {
  it('右键 → 关闭 / 关闭其他 / 关闭右侧 / 全部关闭(无「关闭已保存」)', () => {
    const { tab } = renderDockTab('t2', ['t1', 't2', 't3']);
    fireEvent.contextMenu(tab);
    expect(labels()).toEqual(['Close', 'Close Others', 'Close to the Right', 'Close All']);
  });

  it('关闭其他 → 依次关闭其余面板,不关自己', async () => {
    const { tab, panels } = renderDockTab('t2', ['t1', 't2', 't3']);
    fireEvent.contextMenu(tab);
    fireEvent.click(item('Close Others'));
    await act(async () => {});
    expect(panels.map((p) => p.api.close.mock.calls.length)).toEqual([1, 0, 1]);
  });

  it('单个面板:「关闭其他」「关闭右侧」禁用;Shift+F10 打开菜单', () => {
    const { tab } = renderDockTab('t1', ['t1']);
    fireEvent.keyDown(tab, { key: 'F10', shiftKey: true });
    expect(item('Close Others').hasAttribute('disabled')).toBe(true);
    expect(item('Close to the Right').hasAttribute('disabled')).toBe(true);
  });

  it('批量关闭遇关闭确认:等答复;取消 → 其余面板不关', async () => {
    let answer: (ok: boolean) => void = () => {};
    const closed: string[] = [];
    const make = (id: string) => {
      const panel = { api: { id, close: () => closed.push(id) }, group: undefined } as never;
      wrapPanelClose(panel, (p: { api: { id: string } }) =>
        p.api.id === 'b' ? new Promise<boolean>((resolve) => (answer = resolve)) : true,
      );
      return panel;
    };
    vi.useFakeTimers();
    try {
      const done = closePanelsInOrder([make('a'), make('b'), make('c')]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(closed).toEqual(['a']); // b 在等确认,c 尚未发起
      answer(false);
      await done;
      await vi.advanceTimersByTimeAsync(1000);
      expect(closed).toEqual(['a']);
    } finally {
      vi.useRealTimers();
    }
  });
});
