// @vitest-environment jsdom

// fresh 是一次性启动参数:只作用于用户显式开窗的首次加载。renderer 消费后立即从地址栏去掉,
// 之后的任何刷新(View → Reload / Force Reload、dev 同 URL 刷新、DevTools 刷新)都按本窗段恢复,
// 不再把刷新当成新窗口覆盖本窗段(root 回退、编辑器 tab 全丢)。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import {
  consumeStartupQuery,
  MAX_STARTUP_QUERY_LEN,
  type StartupLocation,
  type StartupHistory,
} from '../../lib/initial-workspace';
import {
  initExplorerPersistence,
  type ExplorerSnapshot,
} from '../../lib/persist/explorer-persist';

beforeEach(() => {
  useWorkspaceStore.setState({ root: null, recentRoots: [] });
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
});

/** 假地址栏:replaceState 真改 search / hash,模拟刷新后按新地址重新解析。 */
function fakeWindow(search: string, hash = ''): {
  loc: StartupLocation;
  history: StartupHistory & { replaceState: ReturnType<typeof vi.fn> };
} {
  const loc = { pathname: '/index.html', search, hash };
  const history = {
    state: { marker: 1 },
    replaceState: vi.fn((_state: unknown, _unused: string, url?: string | URL | null) => {
      const u = new URL(String(url), 'file:///');
      loc.pathname = u.pathname;
      loc.search = u.search;
      loc.hash = u.hash;
    }),
  };
  return { loc, history };
}

describe('fresh 一次性启动参数:消费后去掉,刷新不再当新窗口', () => {
  it('带 fresh 时返回解析结果,并把 fresh 从地址里去掉(保留 windowSeq / workspace / 其它参数与 hash)', () => {
    const { loc, history } = fakeWindow('?windowSeq=2&workspace=%2Fa%20b&fresh=1&x=y', '#h');

    expect(consumeStartupQuery(loc, history)).toEqual({
      windowSeq: 2,
      workspace: '/a b',
      fresh: true,
    });
    expect(history.replaceState).toHaveBeenCalledTimes(1);
    expect(history.replaceState.mock.calls[0]![0]).toEqual({ marker: 1 });
    const params = new URLSearchParams(loc.search);
    expect(params.has('fresh')).toBe(false);
    expect(params.get('windowSeq')).toBe('2');
    expect(params.get('workspace')).toBe('/a b');
    expect(params.get('x')).toBe('y');
    expect(loc.pathname).toBe('/index.html');
    expect(loc.hash).toBe('#h');
  });

  it('不带 fresh 时不改地址', () => {
    const { loc, history } = fakeWindow('?windowSeq=1&workspace=%2Fx');
    expect(consumeStartupQuery(loc, history)).toEqual({
      windowSeq: 1,
      workspace: '/x',
      fresh: false,
    });
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it('超长 query 不解析也不改地址', () => {
    const { loc, history } = fakeWindow(`?fresh=1&pad=${'a'.repeat(MAX_STARTUP_QUERY_LEN)}`);
    expect(consumeStartupQuery(loc, history).fresh).toBe(false);
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it('fresh 开的窗口换 root、开文件后刷新:按本窗段恢复 root 与编辑器 tab', async () => {
    const { loc, history } = fakeWindow('?windowSeq=1&workspace=%2FX&fresh=1');
    expect(consumeStartupQuery(loc, history).fresh).toBe(true);

    // 刷新前 flush 已把本窗段(root 换成 /Y、开着 /Y/a.ts)写盘;刷新 = 按当前地址重新解析。
    const reloaded = consumeStartupQuery(loc, history);
    expect(reloaded).toEqual({ windowSeq: 1, workspace: '/X', fresh: false });

    const data: ExplorerSnapshot = {
      version: 3,
      workspace: { recentRoots: ['/Y', '/X'] },
      pinned: { paths: [] },
      nextWindowSeq: 2,
      windows: [
        {
          windowSeq: 1,
          workspace: { root: '/Y' },
          explorer: { activePath: null, expandedPaths: ['/Y'], sort: { by: 'name', reverse: false } },
          layoutUi: { sidebarOpen: true, sidebarWidth: 320 },
          editor: { openFilePaths: ['/Y/a.ts'], activePath: '/Y/a.ts' },
        },
      ],
    };
    await initExplorerPersistence(
      {
        read: vi.fn(async () => ({ ok: true as const, data })),
        write: vi.fn(async () => ({ ok: true as const, data: undefined })),
        touchRecent: vi.fn(async () => ({ ok: true as const, data: undefined })),
      },
      {
        fs: { readFile: vi.fn(async () => ({ ok: true as const, data: 'a' })) },
        windowSeq: reloaded.windowSeq,
        ...(reloaded.workspace !== null ? { initialWorkspace: reloaded.workspace } : {}),
        ...(reloaded.fresh ? { fresh: true } : {}),
      },
    );

    expect(useWorkspaceStore.getState().root).toBe('/Y');
    expect(useEditorStore.getState().tabs.map((t) => t.filePath)).toEqual(['/Y/a.ts']);
  });
});

describe('main-app 启动接线', () => {
  it('经 consumeStartupQuery 解析真实地址栏(会去掉 fresh),不再直接按 location.search 解析 fresh', () => {
    const src = readFileSync(path.resolve(__dirname, '../../main-app.ts'), 'utf8');
    expect(src).toContain('consumeStartupQuery(window.location, window.history)');
    expect(src).not.toMatch(/parseInitialFresh\(/);
  });
});

// fresh 覆盖 / 段缺失按 query 建段的结果须主动落盘:写订阅在 hydrate 之后才注册、hydrate 不标脏,此前要等第一次
// store 变更才写 → 冷启动 dock 模式主窗(盘上仍有上次会话本窗段)在首次写盘前 dev 同 URL / DevTools 刷新
//(fresh 已被 replaceState 去掉)会按旧段恢复旧 root。打包版菜单 Reload 先 flush 不受影响。
describe('新窗口 hydrate 的结果无需任何 store 变更即落盘', () => {
  const oldSeg = {
    windowSeq: 0,
    workspace: { root: '/Old' },
    explorer: { activePath: null, expandedPaths: ['/Old'], sort: { by: 'name' as const, reverse: false } },
    layoutUi: { sidebarOpen: true, sidebarWidth: 320 },
    editor: { openFilePaths: ['/Old/a.ts'], activePath: '/Old/a.ts' },
  };
  const snapWith = (windows: ExplorerSnapshot['windows']): ExplorerSnapshot => ({
    version: 3,
    workspace: { recentRoots: ['/Old'] },
    pinned: { paths: [] },
    nextWindowSeq: 1,
    windows,
  });

  async function initAndSettle(data: ExplorerSnapshot, fresh: boolean) {
    vi.useFakeTimers();
    try {
      const write = vi.fn(async (_snap: ExplorerSnapshot) => ({ ok: true as const, data: undefined }));
      await initExplorerPersistence(
        {
          read: vi.fn(async () => ({ ok: true as const, data })),
          write,
          touchRecent: vi.fn(async () => ({ ok: true as const, data: undefined })),
        },
        {
          fs: { readFile: vi.fn(async () => ({ ok: true as const, data: 'a' })) },
          windowSeq: 0,
          initialWorkspace: '/New',
          ...(fresh ? { fresh: true } : {}),
        },
      );
      await vi.advanceTimersByTimeAsync(2000);
      return write;
    } finally {
      vi.useRealTimers();
    }
  }

  const mySeg = (write: ReturnType<typeof vi.fn>) =>
    (write.mock.calls.at(-1)?.[0] as ExplorerSnapshot | undefined)?.windows.find((w) => w.windowSeq === 0);

  it('fresh 覆盖盘上旧段:防抖到期后本窗段已是 fresh 结果(新 root、无旧 tab)', async () => {
    const write = await initAndSettle(snapWith([oldSeg]), true);
    expect(write).toHaveBeenCalled();
    expect(mySeg(write)?.workspace.root).toBe('/New');
    expect(mySeg(write)?.editor?.openFilePaths).toEqual([]);
  });

  it('段缺失按 query 建段:防抖到期后本窗段已落盘', async () => {
    const write = await initAndSettle(snapWith([]), false);
    expect(write).toHaveBeenCalled();
    expect(mySeg(write)?.workspace.root).toBe('/New');
  });
});
