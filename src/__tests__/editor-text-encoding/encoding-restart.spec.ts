// @vitest-environment jsdom
// 用户选定的编码跨重启(VSCode FileEditorInputSerializer 序列化 encoding,恢复时作 preferredEncoding):会话快照 editor.encodings
// 只记用户选定的;重启 / 切换文件夹恢复时按它读,恢复出的 tab 仍是用户选定;按它读不出 → 不打开、交给调用方提示可重新选编码。
// 行为见同目录 README「跨重启」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/co-api', () => ({
  coApi: { search: { start: vi.fn(async () => ({ ok: true })), cancel: vi.fn(async () => ({ ok: true })), onEvent: () => () => {} } },
}));
vi.mock('@/plugins/co-app', () => ({ coApp: { editor: { openFile: vi.fn() } } }));
const notifyMock = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('@/notifications/notify', () => ({ notify: notifyMock }));

import { createTab, useEditorStore, withEncoding, type EditorTab } from '@/stores/editor.store';
import { setBeforeWorkspaceRootSwitch, useWorkspaceStore } from '@/stores/workspace.store';
import { clearEditorViewStates } from '@/panels/Editor/editor-view-state-cache';
import { clearRecentlyClosedEditors, popRecentlyClosedEditor } from '@/panels/Editor/recently-closed-editors';
import { __resetSearchForTest } from '@/panels/Search/search-store';
import {
  collectEditorEncodings,
  hydrateEditorTabs,
  initExplorerPersistence,
  snapshotFromStores,
  type EditorSessionFsApi,
  type ExplorerPersistApi,
  type ExplorerSnapshot,
} from '@/lib/persist/explorer-persist';
import { notifyRestoreEncodingFailed } from '@/notifications/notify-open-failed';
import { useEncodingPickerStore } from '@/plugins/editor-encoding/store';
import { acceptEncodingPick } from '@/plugins/editor-encoding/encoding-actions';
import {
  EDITOR_VIEW_STATES_MAX,
  ExplorerSchemaV3,
  ExplorerWritableSnapshotSchema,
  type WorkspaceSnapshotState,
} from '../../../electron/shared/explorer-persistence-schema';
import { scopeWorkspaceSnapshot } from '../../../electron/main/services/workspace-snapshot.service';
import type { FsReadFileResult } from '../../../electron/shared/fs-channels';
import type { TextEncodingId } from '../../../electron/shared/text-encoding';
import { flushMicrotasks } from '../_helpers/async';

const SORT = { by: 'name', reverse: false } as const;
type EditorSession = NonNullable<ExplorerSnapshot['windows'][number]['editor']>;

function snapWith(editor: EditorSession, root: string | null = '/ws'): ExplorerSnapshot {
  return {
    version: 3,
    workspace: { recentRoots: [] },
    pinned: { paths: [] },
    nextWindowSeq: 1,
    windows: [{ windowSeq: 0, workspace: { root }, explorer: { activePath: null, expandedPaths: [], sort: SORT }, editor }],
  };
}

/**
 * 磁盘:path → { 文本, 实际编码 }。未指定编码 → 只认 utf8 / BOM(auto 为 true 的),否则 FS_UNKNOWN_ENCODING;
 * 指定编码与实际不符 → FS_DECODE_FAILED(模拟解码不可逆)。
 */
type DiskFile = { text: string; encoding: TextEncodingId; auto?: boolean };
function diskFs(files: Record<string, DiskFile>) {
  const readFile = vi.fn(async (p: string, opts?: { readonly encoding: TextEncodingId }): Promise<FsReadFileResult> => {
    const f = files[p];
    if (!f) return { ok: false, code: 'FS_NOT_FOUND', message: 'nf' };
    if (opts === undefined) {
      if (f.auto !== true) return { ok: false, code: 'FS_UNKNOWN_ENCODING', message: 'not utf8' };
      return f.encoding === 'utf8' ? { ok: true, data: f.text } : { ok: true, data: f.text, encoding: f.encoding };
    }
    if (opts.encoding !== f.encoding) return { ok: false, code: 'FS_DECODE_FAILED', message: 'lossy' };
    return opts.encoding === 'utf8' ? { ok: true, data: f.text } : { ok: true, data: f.text, encoding: opts.encoding };
  });
  return { readFile } satisfies EditorSessionFsApi;
}

const tabOf = (p: string): EditorTab | undefined => useEditorStore.getState().tabs.find((t) => t.filePath === p);
const editorOf = (snap: ExplorerSnapshot): EditorSession => snap.windows[0]!.editor!;

function resetEditor(): void {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    mode: 'source',
  });
}

beforeEach(() => {
  clearEditorViewStates();
  clearRecentlyClosedEditors();
  __resetSearchForTest();
  resetEditor();
  useWorkspaceStore.setState({ root: '/ws', recentRoots: [], rootRestored: false });
  notifyMock.error.mockReset();
  useEncodingPickerStore.getState().close();
});
afterEach(() => setBeforeWorkspaceRootSwitch(null));

describe('写快照:editor.encodings 只记用户选定的编码', () => {
  it('选定 GBK / UTF-8 的 tab 各一条;自动识别的 UTF-16(BOM)与 UTF-8 不写;没有选定的 → 不写该字段(旧形态)', () => {
    const store = useEditorStore.getState();
    store.openTab(createTab('/ws/plain.txt', 'a'));
    expect(editorOf(snapshotFromStores())).not.toHaveProperty('encodings');

    store.openTab(createTab('/ws/le.txt', 'b', undefined, 'utf16le')); // 自动识别(BOM)
    store.openTab(withEncoding(createTab('/ws/gbk.txt', '中'), 'gbk', true));
    store.openTab(withEncoding(createTab('/ws/forced.txt', 'x'), 'utf8', true)); // 用户选定 UTF-8 也记
    const editor = editorOf(snapshotFromStores());
    expect(editor.encodings).toEqual([
      { path: '/ws/gbk.txt', encoding: 'gbk' },
      { path: '/ws/forced.txt', encoding: 'utf8' },
    ]);
    expect(ExplorerWritableSnapshotSchema.safeParse(snapshotFromStores()).success).toBe(true);
  });

  it('「通过编码保存」后(setEncoding)写入;插件打开的 tab 不写(同 openFilePaths 口径);条数上限同 viewStates', () => {
    const store = useEditorStore.getState();
    store.openTab(createTab('/ws/a.txt', 'a'));
    store.setEncoding('/ws/a.txt', 'utf16be');
    store.openTab({ ...withEncoding(createTab('/ws/p.txt', 'p'), 'gbk', true), pluginOpenedPath: '/ws/p.txt' });
    expect(editorOf(snapshotFromStores()).encodings).toEqual([{ path: '/ws/a.txt', encoding: 'utf16be' }]);

    const many = Array.from({ length: EDITOR_VIEW_STATES_MAX + 5 }, (_, i) =>
      withEncoding(createTab(`/ws/f${i}.txt`, 'x'), 'gbk', true),
    );
    expect(collectEditorEncodings(many)).toHaveLength(EDITOR_VIEW_STATES_MAX);
  });

  it('设定编码 / 选定编码会调度一次持久化写(编码变化 bump chromeVersion)', async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(async () => ({ ok: true as const, data: undefined }));
      const snap = snapWith({ openFilePaths: [], activePath: null });
      await initExplorerPersistence({ read: async () => ({ ok: true, data: snap }), write }, { windowSeq: 0 });
      useEditorStore.getState().openTab(createTab('/ws/a.txt', 'a'));
      await vi.advanceTimersByTimeAsync(400);
      write.mockClear();
      useEditorStore.getState().setEncoding('/ws/a.txt', 'gbk');
      await vi.advanceTimersByTimeAsync(400);
      expect(write).toHaveBeenCalledTimes(1);
      const written = (write.mock.calls[0] as unknown as [ExplorerSnapshot])[0];
      expect(editorOf(written).encodings).toEqual([{ path: '/ws/a.txt', encoding: 'gbk' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('磁盘契约', () => {
  it('编码 id 是白名单(shared/text-encoding);未知 id / 多余字段 → 整份快照按损坏处理;旧数据无该字段照常读', () => {
    const ok = snapWith({ openFilePaths: ['/ws/a'], activePath: null, encodings: [{ path: '/ws/a', encoding: 'gbk' }] });
    expect(ExplorerSchemaV3.safeParse(ok).success).toBe(true);
    const bad = snapWith({
      openFilePaths: ['/ws/a'],
      activePath: null,
      encodings: [{ path: '/ws/a', encoding: 'ebcdic' as TextEncodingId }],
    });
    expect(ExplorerSchemaV3.safeParse(bad).success).toBe(false);
    const extra = snapWith({
      openFilePaths: [],
      activePath: null,
      encodings: [{ path: '/ws/a', encoding: 'gbk', pinned: true } as never],
    });
    expect(ExplorerSchemaV3.safeParse(extra).success).toBe(false);
    expect(ExplorerSchemaV3.safeParse(snapWith({ openFilePaths: ['/ws/a'], activePath: null })).success).toBe(true);
  });

  it('按文件夹快照只留 root 内文件的编码(同 viewStates);全部剔除 → 不写该字段', () => {
    const state: WorkspaceSnapshotState = {
      workspace: { root: '/ws' },
      explorer: { activePath: null, expandedPaths: [], sort: SORT },
      editor: {
        openFilePaths: ['/ws/a.txt', '/other/b.txt'],
        activePath: '/ws/a.txt',
        encodings: [
          { path: '/ws/a.txt', encoding: 'gbk' },
          { path: '/other/b.txt', encoding: 'shiftjis' },
        ],
      },
    };
    expect(scopeWorkspaceSnapshot(state).editor?.encodings).toEqual([{ path: '/ws/a.txt', encoding: 'gbk' }]);
    const outside = { ...state, editor: { ...state.editor!, encodings: [{ path: '/other/b.txt', encoding: 'gbk' as const }] } };
    expect(scopeWorkspaceSnapshot(outside).editor).not.toHaveProperty('encodings');
  });
});

describe('恢复:按记录的编码读', () => {
  it('记录了编码的按它读,其余照常自动识别;恢复出的 tab 编码与「用户选定」都保留(之后的读盘 / ⇧⌘T 仍按它)', async () => {
    const fs = diskFs({
      '/ws/gbk.txt': { text: '中文', encoding: 'gbk' },
      '/ws/le.txt': { text: 'le', encoding: 'utf16le', auto: true },
      '/ws/a.txt': { text: 'a', encoding: 'utf8', auto: true },
    });
    const snap = snapWith({
      openFilePaths: ['/ws/gbk.txt', '/ws/le.txt', '/ws/a.txt'],
      activePath: '/ws/gbk.txt',
      encodings: [{ path: '/ws/gbk.txt', encoding: 'gbk' }],
    });
    await hydrateEditorTabs(snap, fs);
    expect(fs.readFile.mock.calls).toEqual([['/ws/gbk.txt', { encoding: 'gbk' }], ['/ws/le.txt'], ['/ws/a.txt']]);
    expect(tabOf('/ws/gbk.txt')).toMatchObject({ content: '中文', encoding: 'gbk', encodingPinned: true });
    expect(tabOf('/ws/le.txt')).toMatchObject({ encoding: 'utf16le' });
    expect(tabOf('/ws/le.txt')?.encodingPinned).toBeUndefined();
    expect(useEditorStore.getState().activeTabId).toBe('/ws/gbk.txt');
    // 恢复后仍写回同一记录(下次重启照样恢复)
    expect(editorOf(snapshotFromStores()).encodings).toEqual([{ path: '/ws/gbk.txt', encoding: 'gbk' }]);
    // ⇧⌘T:关掉再重新打开仍按 GBK
    useEditorStore.getState().closeTab('/ws/gbk.txt');
    expect(popRecentlyClosedEditor()).toMatchObject({ path: '/ws/gbk.txt', encoding: 'gbk' });
  });

  it('多个编辑器组:按组分配的文档同样按记录的编码读', async () => {
    const fs = diskFs({
      '/ws/gbk.txt': { text: '中文', encoding: 'gbk' },
      '/ws/a.txt': { text: 'a', encoding: 'utf8', auto: true },
    });
    const snap = snapWith({
      openFilePaths: ['/ws/a.txt', '/ws/gbk.txt'],
      activePath: '/ws/gbk.txt',
      encodings: [{ path: '/ws/gbk.txt', encoding: 'gbk' }],
      groups: [
        { id: 'editor', openFilePaths: ['/ws/a.txt'], activePath: '/ws/a.txt' },
        { id: 'editor-2', openFilePaths: ['/ws/gbk.txt', '/ws/a.txt'], activePath: '/ws/gbk.txt' },
      ],
      activeGroup: 'editor-2',
    });
    await hydrateEditorTabs(snap, fs);
    expect(useEditorStore.getState().groups.map((g) => g.tabIds)).toEqual([['/ws/a.txt'], ['/ws/gbk.txt', '/ws/a.txt']]);
    expect(tabOf('/ws/gbk.txt')).toMatchObject({ encoding: 'gbk', encodingPinned: true });
  });

  it('按记录的编码读不出(文件已换成别的编码)/ 无记录且不是 UTF-8 → 不打开(不静默错码),交给 onEncodingFailed;其它失败照旧静默跳过', async () => {
    const fs = diskFs({
      '/ws/changed.txt': { text: 'x', encoding: 'shiftjis' }, // 上次按 GBK,现在 GBK 解不了
      '/ws/old-gbk.txt': { text: 'x', encoding: 'gbk' }, // 旧数据:没有编码记录
      '/ws/a.txt': { text: 'a', encoding: 'utf8', auto: true },
    });
    const onFailed = vi.fn();
    const snap = snapWith({
      openFilePaths: ['/ws/changed.txt', '/ws/old-gbk.txt', '/ws/gone.txt', '/ws/a.txt'],
      activePath: '/ws/changed.txt',
      encodings: [{ path: '/ws/changed.txt', encoding: 'gbk' }],
    });
    await hydrateEditorTabs(snap, fs, 0, onFailed);
    expect(useEditorStore.getState().tabs.map((t) => t.filePath)).toEqual(['/ws/a.txt']);
    expect(onFailed.mock.calls).toEqual([
      ['/ws/changed.txt', { code: 'FS_DECODE_FAILED', message: 'lossy' }],
      ['/ws/old-gbk.txt', { code: 'FS_UNKNOWN_ENCODING', message: 'not utf8' }],
    ]);
  });

  it('读盘期间用户已自己打开了该文件 → 不提示', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fs: EditorSessionFsApi = {
      readFile: vi.fn(async () => {
        await gate;
        return { ok: false as const, code: 'FS_DECODE_FAILED', message: 'lossy' };
      }),
    };
    const onFailed = vi.fn();
    const p = hydrateEditorTabs(
      snapWith({ openFilePaths: ['/ws/g.txt'], activePath: null, encodings: [{ path: '/ws/g.txt', encoding: 'gbk' }] }),
      fs,
      0,
      onFailed,
    );
    useEditorStore.getState().openTab(withEncoding(createTab('/ws/g.txt', 'mine'), 'shiftjis', true));
    release();
    await p;
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('启动恢复把失败交给 extras.onRestoreEncodingFailed;同一窗口切回有快照的文件夹同样按记录的编码读', async () => {
    const fs = diskFs({
      '/ws/gbk.txt': { text: '中文', encoding: 'gbk' },
      '/ws/bad.txt': { text: 'x', encoding: 'shiftjis' },
      '/ws2/b.txt': { text: 'b', encoding: 'utf8', auto: true },
    });
    const onRestoreEncodingFailed = vi.fn();
    let saved: WorkspaceSnapshotState | null = null;
    const switchWorkspace = vi.fn(async (input: { save: WorkspaceSnapshotState | null; open: string | null }) => {
      if (input.open === '/ws2') {
        saved = input.save;
        return { ok: true as const, data: null };
      }
      return { ok: true as const, data: saved };
    });
    const api: ExplorerPersistApi = {
      read: async () => ({
        ok: true,
        data: snapWith({
          openFilePaths: ['/ws/gbk.txt', '/ws/bad.txt'],
          activePath: '/ws/gbk.txt',
          encodings: [
            { path: '/ws/gbk.txt', encoding: 'gbk' },
            { path: '/ws/bad.txt', encoding: 'gbk' },
          ],
        }),
      }),
      write: vi.fn(async () => ({ ok: true as const, data: undefined })),
      switchWorkspace: switchWorkspace as unknown as ExplorerPersistApi['switchWorkspace'],
    };
    useWorkspaceStore.setState({ root: null });
    await initExplorerPersistence(api, { fs, windowSeq: 0, onRestoreEncodingFailed });
    expect(tabOf('/ws/gbk.txt')).toMatchObject({ encoding: 'gbk', encodingPinned: true });
    expect(onRestoreEncodingFailed).toHaveBeenCalledTimes(1);
    expect(onRestoreEncodingFailed.mock.calls[0]![0]).toBe('/ws/bad.txt');

    useWorkspaceStore.getState().setRoot('/ws2');
    await flushMicrotasks(5);
    expect(saved!.editor?.encodings).toEqual([{ path: '/ws/gbk.txt', encoding: 'gbk' }]);
    expect(tabOf('/ws/gbk.txt')).toBeUndefined();
    fs.readFile.mockClear();
    useWorkspaceStore.getState().setRoot('/ws');
    await vi.waitFor(() => expect(tabOf('/ws/gbk.txt')).toMatchObject({ encoding: 'gbk', encodingPinned: true }));
    expect(fs.readFile).toHaveBeenCalledWith('/ws/gbk.txt', { encoding: 'gbk' });
  });
});

describe('恢复失败的提示', () => {
  it('「恢复失败 <文件名>：<原因>」带「通过编码重新打开」:点了弹编码选择器,选定后按该编码打开', async () => {
    const open = vi.fn(async () => ({ ok: true as const }));
    notifyRestoreEncodingFailed('g.txt', { code: 'FS_DECODE_FAILED', message: 'lossy' }, open);
    expect(notifyMock.error).toHaveBeenCalledTimes(1);
    const [message, opts] = notifyMock.error.mock.calls[0]! as [string, { code: string; actions: { label: string; run: () => void }[] }];
    expect(message).toContain('g.txt');
    expect(opts.code).toBe('FS_DECODE_FAILED');
    expect(opts.actions).toHaveLength(1);
    expect(useEncodingPickerStore.getState().request).toBeNull();
    opts.actions[0]!.run();
    const request = useEncodingPickerStore.getState().request;
    expect(request).toMatchObject({ kind: 'open', name: 'g.txt' });
    acceptEncodingPick(request!, 'shiftjis');
    await flushMicrotasks(3);
    expect(open).toHaveBeenCalledWith('shiftjis');
  });
});
