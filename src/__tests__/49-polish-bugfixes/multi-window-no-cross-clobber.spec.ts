// topic 49 第七轮 · P1-U:多窗口并存时不互相覆盖窗口段。
//
// 根因:每个 renderer 把"自己看到的全量快照"(含其它窗口段)作为写入单元。
// `lastSnap` 在本窗启动时读盘一次,之后只被自己写的内容更新、**从不重读磁盘**。
// 窗口 A 启动时拿到的 B 段是当时的快照;之后 B 改了 root/tabs/expanded 并写盘;
// 随后 A 因任意 store 变化落盘时,`snapshotFromStores` 把陈旧的 B 段一并写回 →
// `mergeWritableIntoFull` 用陈旧 B 覆盖磁盘上 B 的最新段 → B 的最新工作区/标签页/
// 展开状态被回退(跨窗状态丢失)。
//
// 修复:`snapshotFromStores` 只输出自己这一段(windows:[myEntry]),不携带
// otherWindows。main 的 explorer:write 在 file-mutex 内重读磁盘 current,merge
// 对 writable 没有的 windowSeq 保留磁盘最新段 → 其它窗口段永不被陈旧数据回退。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  snapshotFromStores,
  hydrateStores,
} from '../../lib/persist/explorer-persist';
import {
  mergeWritableIntoFull,
  type ExplorerPayloadV3,
} from '../../../electron/main/persistence';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useExplorerStore } from '../../stores/explorer.store';
import { usePinnedStore } from '../../stores/pinned.store';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { useEditorStore } from '../../stores/editor.store';

beforeEach(() => {
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useExplorerStore.setState({
    expandedPaths: new Set(),
    sort: { by: 'name', reverse: false },
  });
  usePinnedStore.setState({ paths: [] });
  useLayoutUiStore.setState({ sidebarOpen: true, sidebarWidth: 280 });
  useEditorStore.setState({ tabs: [], activeTabId: null });
});

describe('topic49 P1-U · 多窗口段不互相覆盖', () => {
  it('snapshotFromStores 只输出本窗段,不携带其它窗口段', () => {
    // 模拟本窗(seq 0)启动时 lastSnap 里有别的窗口 seq 1 的段
    const staleSnap = {
      version: 3 as const,
      workspace: { recentRoots: [] },
      pinned: { paths: [] },
      nextWindowSeq: 2,
      windows: [
        {
          windowSeq: 0,
          workspace: { root: '/win0' },
          explorer: { activePath: null, expandedPaths: [], sort: { by: 'name' as const, reverse: false } },
        },
        {
          windowSeq: 1,
          workspace: { root: '/win1-STALE' },
          explorer: { activePath: null, expandedPaths: [], sort: { by: 'name' as const, reverse: false } },
        },
      ],
    };
    useWorkspaceStore.setState({ root: '/win0-fresh', recentRoots: [] });

    const snap = snapshotFromStores(staleSnap, 0);
    // 只有本窗 seq 0,绝不带 seq 1 的陈旧段
    expect(snap.windows).toHaveLength(1);
    expect(snap.windows[0]!.windowSeq).toBe(0);
    expect(snap.windows.some((w) => w.windowSeq === 1)).toBe(false);
  });

  it('端到端:A 写盘不回退 B 在磁盘上的最新段', () => {
    // 磁盘当前:B(seq 1)已写入最新 root /win1-NEW
    const disk: ExplorerPayloadV3 = {
      version: 3,
      workspace: { recentRoots: [] },
      pinned: { paths: [] },
      nextWindowSeq: 2,
      windows: [
        {
          windowSeq: 0,
          workspace: { root: '/win0' },
          explorer: { activePath: null, expandedPaths: [], sort: { by: 'name', reverse: false } },
        },
        {
          windowSeq: 1,
          workspace: { root: '/win1-NEW' },
          explorer: { activePath: '/win1-NEW/x.md', expandedPaths: ['/win1-NEW'], sort: { by: 'name', reverse: false } },
        },
      ],
    };

    // A(seq 0)启动时 lastSnap 里 B 还是旧 root /win1-OLD
    const aLastSnap = {
      version: 3 as const,
      workspace: { recentRoots: [] },
      pinned: { paths: [] },
      nextWindowSeq: 2,
      windows: [
        disk.windows[0]!,
        {
          windowSeq: 1,
          workspace: { root: '/win1-OLD' },
          explorer: { activePath: null, expandedPaths: [], sort: { by: 'name' as const, reverse: false } },
        },
      ],
    };

    // A 改了自己的 root,落盘
    useWorkspaceStore.setState({ root: '/win0-edited', recentRoots: [] });
    const aWritable = snapshotFromStores(aLastSnap, 0);
    const merged = mergeWritableIntoFull(
      disk,
      aWritable as unknown as Parameters<typeof mergeWritableIntoFull>[1],
    );

    // B(seq 1)磁盘最新段被保留,没有被 A 携带的陈旧 /win1-OLD 覆盖
    const b = merged.windows.find((w) => w.windowSeq === 1)!;
    expect(b.workspace.root).toBe('/win1-NEW');
    expect(b.explorer.activePath).toBe('/win1-NEW/x.md');
    // A 自己段更新生效
    const a = merged.windows.find((w) => w.windowSeq === 0)!;
    expect(a.workspace.root).toBe('/win0-edited');
  });

  it('回归:hydrate 后 snapshot 往返不丢本窗字段', () => {
    const full = {
      version: 3 as const,
      workspace: { recentRoots: ['/r'] },
      pinned: { paths: ['/p.md'] },
      nextWindowSeq: 1,
      windows: [
        {
          windowSeq: 0,
          workspace: { root: '/work' },
          explorer: { activePath: '/work/a.md', expandedPaths: ['/work'], sort: { by: 'mtime' as const, reverse: true } },
          layoutUi: { sidebarOpen: false, sidebarWidth: 300 },
        },
      ],
    };
    hydrateStores(full, 0);
    const snap = snapshotFromStores(full, 0);
    expect(snap.windows[0]!.workspace.root).toBe('/work');
    // 打磨 R18:explorer.activePath 已不在 store,本窗 snapshot 写保留位 null
    // (磁盘里旧值 hydrate 时被忽略)。expandedPaths/sort/pinned 仍正常往返。
    expect(snap.windows[0]!.explorer.activePath).toBeNull();
    expect(snap.windows[0]!.explorer.expandedPaths).toEqual(['/work']);
    expect(snap.pinned.paths).toEqual(['/p.md']);
    expect(snap.workspace.recentRoots).toEqual(['/r']);
  });
});
