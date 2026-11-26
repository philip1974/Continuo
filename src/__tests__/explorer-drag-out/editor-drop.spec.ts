// BDD:资源管理器的文件拖到编辑器组 —— 接收判定、落点 → 拆分方向、放下后在该组常驻打开。见同目录 README「行为 2」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Position } from 'dockview-react';
import { EXPLORER_DRAG_MIME } from '@/lib/explorer-drag';
import { useEditorStore, groupPreviewTabIdOf, createTab, type EditorTab } from '@/stores/editor.store';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(async (p: string) =>
    p.includes('missing') ? { ok: false as const, code: 'ENOENT', message: 'nope' } : { ok: true as const, data: `// ${p}` },
  ),
  splitEditor: vi.fn(),
  requestEditorFocus: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('@/panels/Editor/editor-file-deps', () => ({
  editorFileDeps: { fs: { readFile: mocks.readFile, writeFile: vi.fn() } },
}));
vi.mock('@/panels/Editor/editor-groups-actions', () => ({ splitEditor: mocks.splitEditor }));
vi.mock('@/panels/Editor/editor-focus-registry', () => ({ requestEditorFocus: mocks.requestEditorFocus }));
vi.mock('@/notifications/notify', () => ({ notify: { error: mocks.notifyError, warn: vi.fn(), info: vi.fn() } }));

import {
  editorGroupIdOfDockGroup,
  openDroppedFiles,
  splitDirectionOfDrop,
  trackExplorerEditorDrop,
} from '@/shell/dock/explorer-editor-drop';

type Listener<E> = (e: E) => void;
function emitter<E>() {
  const ls = new Set<Listener<E>>();
  return {
    event: (l: Listener<E>) => {
      ls.add(l);
      return { dispose: () => ls.delete(l) };
    },
    fire: (e: E) => ls.forEach((l) => l(e)),
    size: () => ls.size,
  };
}

const editorGroup = (id = 'editor') => ({ activePanel: { id, view: { contentComponent: 'editor' } } });
const terminalGroup = { activePanel: { id: 'terminal-1', view: { contentComponent: 'terminal' } } };

function dataTransfer(entries: unknown, extraTypes: string[] = []): DataTransfer {
  const data = new Map<string, string>([[EXPLORER_DRAG_MIME, JSON.stringify(entries)]]);
  return { types: [EXPLORER_DRAG_MIME, ...extraTypes], getData: (f: string) => data.get(f) ?? '' } as unknown as DataTransfer;
}
const osFiles = { types: ['Files'], getData: () => '' } as unknown as DataTransfer;

function setup() {
  const over = emitter<unknown>();
  const drop = emitter<unknown>();
  const open = vi.fn();
  const api = { onUnhandledDragOverEvent: over.event, onDidDrop: drop.event } as never;
  const tracked = trackExplorerEditorDrop(api, open);
  const dragOver = (opts: { dt: DataTransfer; group?: unknown; target?: string; panelData?: unknown }) => {
    let accepted = false;
    over.fire({
      nativeEvent: { dataTransfer: opts.dt },
      target: opts.target ?? 'content',
      position: 'center',
      group: opts.group,
      getData: () => opts.panelData,
      accept: () => (accepted = true),
    });
    return accepted;
  };
  const dropOn = (opts: { dt: DataTransfer; group?: unknown; position?: Position; panelData?: unknown }) =>
    drop.fire({
      nativeEvent: { dataTransfer: opts.dt },
      position: opts.position ?? 'center',
      group: opts.group,
      getData: () => opts.panelData,
    });
  return { open, dragOver, dropOn, tracked, over, drop };
}

describe('接收判定与落点', () => {
  it('拖动经过:树拖出 + 组里显示编辑器组 → 接受(放置高亮);终端组 / 无组 / dock 外缘 / OS 文件 / dockview 自己的拖动 → 不接受', () => {
    const { dragOver } = setup();
    const dt = dataTransfer([{ path: '/w/a.ts', isDirectory: false }]);
    expect(dragOver({ dt, group: editorGroup() })).toBe(true);
    expect(dragOver({ dt, group: editorGroup('editor:2'), target: 'tab' })).toBe(true);
    expect(dragOver({ dt, group: editorGroup(), target: 'header_space' })).toBe(true);
    expect(dragOver({ dt, group: terminalGroup })).toBe(false);
    expect(dragOver({ dt, group: undefined })).toBe(false);
    expect(dragOver({ dt, group: editorGroup(), target: 'edge' })).toBe(false);
    expect(dragOver({ dt: osFiles, group: editorGroup() })).toBe(false);
    expect(dragOver({ dt, group: editorGroup(), panelData: { panelId: 'x' } })).toBe(false);
  });

  it('经过编辑器组自己的 tab 栏(内容区顶部)→ 不接受 dockview 高亮(tab 栏自己接收,不当顶部边缘拆分)', () => {
    const { over } = setup();
    let accepted = false;
    const inTabBar = { closest: (sel: string) => (sel === '[data-editor-tab-bar]' ? {} : null) };
    over.fire({
      nativeEvent: { dataTransfer: dataTransfer([{ path: '/w/a.ts', isDirectory: false }]), target: inTabBar },
      target: 'content',
      position: 'top',
      group: editorGroup(),
      getData: () => undefined,
      accept: () => (accepted = true),
    });
    expect(accepted).toBe(false);
  });

  it('放下:只把文件(不含文件夹)交给打开,带落点对应的拆分方向;只有文件夹 / 非编辑器组 / dockview 拖动 → 不打开', () => {
    const { open, dropOn } = setup();
    const dt = dataTransfer([
      { path: '/w/a.ts', isDirectory: false },
      { path: '/w/src', isDirectory: true },
      { path: '/w/b.ts', isDirectory: false },
    ]);
    dropOn({ dt, group: editorGroup('editor:2') });
    expect(open).toHaveBeenLastCalledWith(['/w/a.ts', '/w/b.ts'], 'editor:2', undefined);
    dropOn({ dt, group: editorGroup(), position: 'right' });
    expect(open).toHaveBeenLastCalledWith(['/w/a.ts', '/w/b.ts'], 'editor', 'right');
    open.mockClear();
    dropOn({ dt: dataTransfer([{ path: '/w/src', isDirectory: true }]), group: editorGroup() });
    dropOn({ dt, group: terminalGroup });
    dropOn({ dt, group: editorGroup(), panelData: { panelId: 'x' } });
    dropOn({ dt: osFiles, group: editorGroup() });
    expect(open).not.toHaveBeenCalled();
  });

  it('落点 → 拆分方向:左 / 右 / 上 / 下边缘拆分,中央不拆分;dispose 后不再监听', () => {
    expect((['left', 'right', 'top', 'bottom', 'center'] as Position[]).map(splitDirectionOfDrop)).toEqual([
      'left',
      'right',
      'up',
      'down',
      undefined,
    ]);
    const { tracked, over, drop } = setup();
    tracked.dispose();
    expect(over.size() + drop.size()).toBe(0);
  });

  it('编辑器组面板的判定:id 形态 + 组件类型', () => {
    expect(editorGroupIdOfDockGroup(editorGroup('editor:3') as never)).toBe('editor:3');
    expect(editorGroupIdOfDockGroup({ activePanel: { id: 'editor', view: { contentComponent: 'settings' } } } as never)).toBeUndefined();
    expect(editorGroupIdOfDockGroup({ activePanel: undefined } as never)).toBeUndefined();
    expect(editorGroupIdOfDockGroup(undefined)).toBeUndefined();
  });
});

describe('放下后的打开', () => {
  const A = '/w/a.ts';
  const B = '/w/b.ts';
  const C = '/w/c.ts';

  beforeEach(() => {
    mocks.readFile.mockClear();
    mocks.splitEditor.mockReset();
    mocks.requestEditorFocus.mockReset();
    mocks.notifyError.mockReset();
    useEditorStore.setState({
      tabs: [],
      activeTabId: null,
      groups: [
        { id: 'editor', tabIds: [], activeTabId: null },
        { id: 'editor:2', tabIds: [], activeTabId: null },
      ],
      activeGroupId: 'editor',
      tabMru: new Map(),
      previewTabs: new Map(),
      mode: 'source',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const group = (id: string) => useEditorStore.getState().groups.find((g) => g.id === id)!;
  const tabIdOf = (path: string) => useEditorStore.getState().tabs.find((t: EditorTab) => t.filePath === path)!.id;

  it('在放下的组按顺序常驻打开,第一个成为活动编辑器,该组成为活动组并请求聚焦', async () => {
    await openDroppedFiles([A, B], 'editor:2');
    const g = group('editor:2');
    expect(g.tabIds.map((id) => useEditorStore.getState().tabs.find((t) => t.id === id)!.filePath)).toEqual([A, B]);
    expect(g.activeTabId).toBe(tabIdOf(A));
    expect(useEditorStore.getState().activeGroupId).toBe('editor:2');
    expect(group('editor').tabIds).toEqual([]);
    expect(groupPreviewTabIdOf(useEditorStore.getState(), 'editor:2')).toBeUndefined();
    expect(mocks.requestEditorFocus).toHaveBeenCalledWith(tabIdOf(A), 'editor:2');
  });

  it('文件已是该组的预览 tab → 转常驻;已在别的组打开 → 也在目标组打开', async () => {
    const st = useEditorStore.getState();
    st.openTab(createTab(A, ''), { groupId: 'editor:2', preview: true });
    st.openTab(createTab(B, ''), { groupId: 'editor' });
    expect(groupPreviewTabIdOf(useEditorStore.getState(), 'editor:2')).toBe(tabIdOf(A));
    await openDroppedFiles([A, B], 'editor:2');
    expect(groupPreviewTabIdOf(useEditorStore.getState(), 'editor:2')).toBeUndefined();
    expect(group('editor:2').tabIds).toEqual([tabIdOf(A), tabIdOf(B)]);
    expect(group('editor').tabIds).toEqual([tabIdOf(B)]);
    expect(group('editor:2').activeTabId).toBe(tabIdOf(A));
  });

  it('打不开的文件照常提示,其余照开;都打不开 → 不切换不聚焦', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await openDroppedFiles(['/w/missing.ts', C], 'editor');
    expect(mocks.notifyError).toHaveBeenCalledTimes(1);
    expect(String(mocks.notifyError.mock.calls[0]![0])).toContain('missing.ts');
    expect(group('editor').activeTabId).toBe(tabIdOf(C));
    mocks.requestEditorFocus.mockReset();
    await openDroppedFiles(['/w/missing2.ts'], 'editor');
    expect(mocks.requestEditorFocus).not.toHaveBeenCalled();
  });

  it('落在边缘 → 先在那一侧拆出新组,再在新组里打开', async () => {
    mocks.splitEditor.mockImplementation((_dir: string, opts: { groupId: string; tabId: null }) =>
      useEditorStore.getState().splitGroup(opts.groupId, 'editor:3', opts.tabId),
    );
    await openDroppedFiles([A], 'editor', 'left');
    expect(mocks.splitEditor).toHaveBeenCalledWith('left', { groupId: 'editor', tabId: null });
    expect(group('editor:3').tabIds).toEqual([tabIdOf(A)]);
    expect(group('editor').tabIds).toEqual([]);
    expect(useEditorStore.getState().activeGroupId).toBe('editor:3');
  });

  it('拆分不了(组数已达上限等)→ 放进原组', async () => {
    mocks.splitEditor.mockReturnValue(false);
    await openDroppedFiles([A], 'editor:2', 'down');
    expect(group('editor:2').tabIds).toEqual([tabIdOf(A)]);
  });
});
