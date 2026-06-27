// @vitest-environment jsdom
// topic 49 第十二 session · codex 复审 loop R13:editor session restore 迟到后必须校验当前 workspace。
//
// 根因:hydrateEditorTabs 在 `await Promise.all(paths.map(readFile))` 后直接 openTab/switchTab,
// 没确认当前 workspace.root 仍是 snapshot 段的 root。readFile 慢时用户可切到别的 workspace
// (setRoot 关 root 外 tab,但此刻旧 tab 还没 restore),迟到 resolve 后把旧项目 tab 插进新
// workspace → 用户在新项目看到/编辑旧项目文件 + 写出 root=新/openFilePaths=旧 的混合持久化。
// 与 R10 终端 hydrate 竞态同类。issue-45 的 !fresh gate 只挡 fresh 拖文件夹,不覆盖此 race。
//
// 修:hydrateEditorTabs 在读文件前捕获 expectedRoot(段 root),读完后、动 editor store 前
// 校验 useWorkspaceStore.getState().root === expectedRoot,变了就整轮丢弃。

import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import {
  hydrateEditorTabs,
  type EditorSessionFsApi,
  type ExplorerSnapshot,
} from '../../lib/persist/explorer-persist';

function snapForRoot(root: string, paths: string[], active: string | null): ExplorerSnapshot {
  return {
    version: 2,
    workspace: { recentRoots: [] },
    pinned: { paths: [] },
    nextWindowSeq: 1,
    windows: [
      {
        windowSeq: 0,
        workspace: { root },
        explorer: { activePath: null, expandedPaths: [], sort: { by: 'name', reverse: false } },
        editor: { openFilePaths: paths, activePath: active },
      },
    ],
  };
}

function deferredFs(path: string): {
  fs: EditorSessionFsApi;
  resolve: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const fs: EditorSessionFsApi = {
    readFile: async (p: string) => {
      if (p === path) await gate;
      return { ok: true as const, data: 'content' };
    },
  };
  return { fs, resolve: release };
}

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
});

describe('topic49 codex-loop R13 · editor restore 校验 workspace', () => {
  it('restore 期间切到别的 workspace → 旧项目 tab 不被插入(整轮丢弃)', async () => {
    useWorkspaceStore.setState({ root: '/proj-a' }); // hydrateStores 刚设的段 root
    const { fs, resolve } = deferredFs('/proj-a/a.md');
    const snap = snapForRoot('/proj-a', ['/proj-a/a.md'], '/proj-a/a.md');

    const p = hydrateEditorTabs(snap, fs, 0); // 不 await,卡在 readFile gate
    // 用户在 restore 在途切到 /proj-b
    useWorkspaceStore.setState({ root: '/proj-b' });
    resolve(); // /proj-a/a.md 迟到 resolve
    await p;

    // 旧项目 tab 不应出现在 /proj-b
    expect(useEditorStore.getState().tabs.find((t) => t.id === '/proj-a/a.md')).toBeUndefined();
    expect(useEditorStore.getState().tabs).toHaveLength(0);
  });

  it('未切 workspace(root 不变)→ 正常 restore 旧 tab', async () => {
    useWorkspaceStore.setState({ root: '/proj-a' });
    const { fs, resolve } = deferredFs('/proj-a/a.md');
    const snap = snapForRoot('/proj-a', ['/proj-a/a.md'], '/proj-a/a.md');

    const p = hydrateEditorTabs(snap, fs, 0);
    resolve();
    await p;

    expect(useEditorStore.getState().tabs.find((t) => t.id === '/proj-a/a.md')).toBeDefined();
    expect(useEditorStore.getState().activeTabId).toBe('/proj-a/a.md');
  });

  // 跨平台(codex 复查 P2,pathEquals 相等族):root 守卫此前用字节级 `!==` 比较。Windows
  // 文件系统大小写不敏感,恢复异步窗口期内若同一文件夹以不同大小写被设为 root(recent/
  // CLI/drag 传入不同 case),守卫误判「已切到别 workspace」→ 整轮跳过恢复 → 后续把
  // openFilePaths 写空。改用平台感知 pathEquals 后,Windows 同路径不同大小写仍恢复。
  it('Windows 同路径不同大小写 → 守卫不误判,仍正常 restore', async () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', {
      value: 'Win32',
      configurable: true,
    });
    try {
      useWorkspaceStore.setState({ root: 'C:\\Proj' });
      const { fs, resolve } = deferredFs('C:\\Proj\\a.md');
      const snap = snapForRoot('C:\\Proj', ['C:\\Proj\\a.md'], 'C:\\Proj\\a.md');

      const p = hydrateEditorTabs(snap, fs, 0);
      // restore 在途,同一文件夹以不同大小写被(重新)设为 root
      useWorkspaceStore.setState({ root: 'c:\\proj' });
      resolve();
      await p;

      expect(
        useEditorStore.getState().tabs.find((t) => t.id === 'C:\\Proj\\a.md'),
      ).toBeDefined();
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
      else delete (navigator as { platform?: string }).platform;
    }
  });

  // POSIX 大小写敏感:仅大小写不同 = 真的是不同 root,守卫仍须丢弃(零行为变化)。
  it('POSIX 仅大小写不同 → 视为不同 root,整轮丢弃', async () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });
    try {
      useWorkspaceStore.setState({ root: '/Proj' });
      const { fs, resolve } = deferredFs('/Proj/a.md');
      const snap = snapForRoot('/Proj', ['/Proj/a.md'], '/Proj/a.md');

      const p = hydrateEditorTabs(snap, fs, 0);
      useWorkspaceStore.setState({ root: '/proj' }); // 大小写不同 = 不同目录
      resolve();
      await p;

      expect(useEditorStore.getState().tabs).toHaveLength(0);
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
      else delete (navigator as { platform?: string }).platform;
    }
  });
});
