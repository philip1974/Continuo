// @vitest-environment jsdom
// BDD:两个编辑器组面板各自渲染自己的 tab;同一文档一处编辑另一处同步(CodeMirror / Milkdown 都增量映射,不重挂);组内关闭。
// 见同目录 README。
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState, type ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ milkdownMounts: [] as { tabId: string; value: string }[] }));

vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: {
      readFile: vi.fn(async () => ({ ok: true, data: '# t' })),
      writeFile: vi.fn(async () => ({ ok: true, data: undefined })),
      onDirChanged: vi.fn(() => vi.fn()),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('../../panels/Editor/MilkdownEditor', () => ({
  MilkdownEditor: ({
    tabId,
    defaultValue,
    value,
    onChange,
  }: {
    tabId: string;
    defaultValue: string;
    value?: string;
    onChange?: (md: string) => void;
  }) => {
    // 同真实 Milkdown:defaultValue 只在挂载时生效;value = 需同步进视图的当前内容(真实编辑器增量套用)
    const [initial] = useState(defaultValue);
    useEffect(() => {
      mocks.milkdownMounts.push({ tabId, value: initial });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <div data-testid="milkdown" data-initial={initial} data-value={value}>
        <button type="button" onClick={() => onChange?.(`${initial}+typed`)}>
          type
        </button>
      </div>
    );
  },
}));

import { createTab, useEditorStore, type EditorTab } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { CodeEditor } from '../../panels/Editor/CodeEditor';
import { EditorGroupIdContext } from '../../panels/Editor/editor-group-context';
import { clearEditorViewStates } from '../../panels/Editor/editor-view-state-cache';
import { setLocale } from '../../i18n';

const A = '/w/a.ts';
const B = '/w/b.ts';
const MD = '/w/n.md';

function api(id: string) {
  return { id, onDidLocationChange: () => ({ dispose: () => {} }) };
}

function reset(): void {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    mode: 'source',
    viewRefs: new Map(),
  });
}

function open(tab: EditorTab): void {
  useEditorStore.getState().openTab(tab);
}

beforeEach(() => {
  setLocale('en');
  reset();
  clearEditorViewStates();
  mocks.milkdownMounts.length = 0;
});
afterEach(() => cleanup());

function renderGroups(): { left: HTMLElement; right: HTMLElement } {
  render(
    <div>
      <div data-testid="left">
        <EditorPanel api={api('editor')} />
      </div>
      <div data-testid="right">
        <EditorPanel api={api('editor:2')} />
      </div>
    </div>,
  );
  return { left: screen.getByTestId('left'), right: screen.getByTestId('right') };
}

function tabNames(root: HTMLElement): string[] {
  return within(root)
    .queryAllByRole('tab')
    .map((el) => el.getAttribute('title') ?? '');
}

describe('两个组面板各自的 tab', () => {
  it('每个面板只显示本组的 tab 与活动文件', async () => {
    open(createTab(A, 'aaa'));
    open(createTab(B, 'bbb'));
    useEditorStore.getState().splitGroup('editor', 'editor:2', A);
    const { left, right } = renderGroups();
    expect(tabNames(left)).toEqual([A, B]);
    expect(tabNames(right)).toEqual([A]);
    expect(await within(right).findByText('aaa')).toBeTruthy();
    expect(within(left).getByRole('tab', { selected: true }).getAttribute('title')).toBe(B);
  });

  it('点另一个组的 tab → 该组成为活动组', () => {
    open(createTab(A, 'aaa'));
    open(createTab(B, 'bbb'));
    useEditorStore.getState().splitGroup('editor', 'editor:2', A);
    const { left } = renderGroups();
    fireEvent.click(within(left).getAllByRole('tab')[0]!);
    expect(useEditorStore.getState().activeGroupId).toBe('editor');
    expect(useEditorStore.getState().activeTabId).toBe(A);
  });

  // VSCode tab.unfocusedActive*:非活动组的活动 tab 文字变暗、无强调下划线(样式见 design TabNav 的 unfocused)
  it('只有非活动组的 tab 栏标成 unfocused;切换活动组随之变化', () => {
    open(createTab(A, 'aaa'));
    useEditorStore.getState().splitGroup('editor', 'editor:2', A); // editor:2 成为活动组
    const { left, right } = renderGroups();
    const strip = (root: HTMLElement) => within(root).getByRole('tablist');
    expect(strip(left).getAttribute('data-unfocused')).toBe('true');
    expect(strip(right).getAttribute('data-unfocused')).not.toBe('true');
    act(() => useEditorStore.getState().setActiveGroup('editor'));
    expect(strip(left).getAttribute('data-unfocused')).not.toBe('true');
    expect(strip(right).getAttribute('data-unfocused')).toBe('true');
  });

  it('关闭仍在别的组打开的脏文档:不弹保存确认,只从本组移除', () => {
    open(createTab(A, 'aaa'));
    open(createTab(B, 'bbb'));
    useEditorStore.getState().splitGroup('editor', 'editor:2', A);
    useEditorStore.getState().updateContent(A, 'changed');
    const { left, right } = renderGroups();
    fireEvent.click(within(right).getByRole('button', { name: /Close a\.ts/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(tabNames(left)).toEqual([A, B]);
    expect(useEditorStore.getState().tabs.find((t) => t.id === A)?.dirty).toBe(true);
  });

  it('关掉组内最后一个文件 → 组关闭(另一组成为活动组)', () => {
    open(createTab(A, 'aaa'));
    open(createTab(B, 'bbb'));
    useEditorStore.getState().splitGroup('editor', 'editor:2', A);
    const { right } = renderGroups();
    fireEvent.click(within(right).getByRole('button', { name: /Close a\.ts/ }));
    const s = useEditorStore.getState();
    expect(s.groups.map((g) => g.id)).toEqual(['editor']);
    expect(s.tabs.map((t) => t.id)).toEqual([A, B]);
  });

  it('编辑区获焦 → 所在组成为活动组', () => {
    open(createTab(A, 'aaa'));
    useEditorStore.getState().splitGroup('editor', 'editor:2', A);
    const { left } = renderGroups();
    act(() => {
      (left.querySelector('[data-editor-panel-root]') as HTMLElement).focus();
    });
    expect(useEditorStore.getState().activeGroupId).toBe('editor');
  });
});

/** 与 EditorPanel 同口径:value 取 store 里的共享内容,onChange 写回 store。 */
function GroupCode({ groupId, tabId }: { groupId: string; tabId: string }): ReactNode {
  const content = useEditorStore((s) => s.tabs.find((t) => t.id === tabId)?.content ?? '');
  return (
    <EditorGroupIdContext.Provider value={groupId}>
      <div data-testid={`cm-${groupId}`}>
        <CodeEditor
          tabId={tabId}
          value={content}
          fileName={tabId}
          onChange={(v) => useEditorStore.getState().updateContent(tabId, v)}
        />
      </div>
    </EditorGroupIdContext.Provider>
  );
}

describe('CodeMirror:同一文档两个视图实时同步', () => {
  it('A 组输入 → B 组文档更新,B 的光标随插入点之前的变化后移(增量映射,不整篇替换)', async () => {
    const { EditorView } = await import('@codemirror/view');
    open(createTab(A, 'hello world'));
    render(
      <div>
        <GroupCode groupId="editor" tabId={A} />
        <GroupCode groupId="editor:2" tabId={A} />
      </div>,
    );
    const left = EditorView.findFromDOM(screen.getByTestId('cm-editor').querySelector('.cm-editor') as HTMLElement)!;
    const right = EditorView.findFromDOM(screen.getByTestId('cm-editor:2').querySelector('.cm-editor') as HTMLElement)!;
    expect(left).not.toBe(right);
    act(() => right.dispatch({ selection: { anchor: 6 } })); // B 光标在 "world" 前
    act(() => left.dispatch({ changes: { from: 0, insert: '>> ' }, userEvent: 'input.type' }));
    expect(useEditorStore.getState().tabs[0]!.content).toBe('>> hello world');
    expect(right.state.doc.toString()).toBe('>> hello world');
    expect(right.state.selection.main.head).toBe(9);
    // B 收到的同步不回写(内容只被 A 写了一次)
    act(() => right.dispatch({ changes: { from: right.state.doc.length, insert: '!' }, userEvent: 'input.type' }));
    expect(left.state.doc.toString()).toBe('>> hello world!');
  });

  it('两个视图各自登记聚焦句柄(按组),不互相覆盖', async () => {
    const { requestEditorFocus } = await import('../../panels/Editor/editor-focus-registry');
    const { EditorView } = await import('@codemirror/view');
    open(createTab(A, 'x'));
    render(
      <div>
        <GroupCode groupId="editor" tabId={A} />
        <GroupCode groupId="editor:2" tabId={A} />
      </div>,
    );
    const left = EditorView.findFromDOM(screen.getByTestId('cm-editor').querySelector('.cm-editor') as HTMLElement)!;
    const spy = vi.spyOn(left, 'focus');
    vi.useFakeTimers({ toFake: ['requestAnimationFrame'] });
    try {
      requestEditorFocus(A, 'editor');
      vi.advanceTimersToNextFrame();
    } finally {
      vi.useRealTimers();
    }
    expect(spy).toHaveBeenCalled();
  });
});

describe('Milkdown:另一组改了内容 → 两组都不重挂,内容经 value 同步给编辑器(编辑器内增量套用)', () => {
  it('A 组输入后,B 组不重挂载、收到新内容;A 也不重挂', async () => {
    useEditorStore.setState({ mode: 'edit' });
    open(createTab(MD, '# t'));
    useEditorStore.getState().splitGroup('editor', 'editor:2', MD);
    const { left, right } = renderGroups();
    await within(left).findByTestId('milkdown');
    await within(right).findByTestId('milkdown');
    mocks.milkdownMounts.length = 0;
    fireEvent.click(within(left).getByText('type'));
    expect(useEditorStore.getState().tabs[0]!.content).toBe('# t+typed');
    expect(within(right).getByTestId('milkdown').getAttribute('data-value')).toBe('# t+typed');
    expect(within(right).getByTestId('milkdown').getAttribute('data-initial')).toBe('# t');
    expect(within(left).getByTestId('milkdown').getAttribute('data-value')).toBe('# t+typed');
    expect(mocks.milkdownMounts).toEqual([]);
  });
});


describe('自动保存:同一 Markdown 在两组都是活动文件 → 只保存一次', () => {
  it('编辑后两组的防抖都到点,只写一次盘(保存按文档串行,后到者发现已不脏)', async () => {
    const { coApi } = await import('../../lib/co-api');
    const write = vi.mocked(coApi.fs.writeFile);
    write.mockClear();
    useEditorStore.setState({ mode: 'edit' });
    open(createTab(MD, '# t'));
    useEditorStore.getState().splitGroup('editor', 'editor:2', MD);
    const { left, right } = renderGroups();
    await within(left).findByTestId('milkdown');
    await within(right).findByTestId('milkdown');
    vi.useFakeTimers();
    try {
      act(() => useEditorStore.getState().updateContent(MD, '# t2'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(write).toHaveBeenCalledTimes(1);
  });
});
