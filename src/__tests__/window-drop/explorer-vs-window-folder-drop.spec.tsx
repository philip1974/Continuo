// @vitest-environment jsdom
// 契约:从 Finder 拖文件夹进窗口 ——
//  · 落在 Explorer 文件树(空白处 / [role=tree] 容器本身)→ 只由 Explorer 复制进落点目录,**不**切换 workspace;
//  · 落在 Explorer 以外(dockview 区域等)→ 仍由 App 全局 drop 监听把 workspace 切到该文件夹。
// 缺陷:FolderTree 容器级 drop 只 preventDefault 不 stopPropagation(行级 drop 才 stop),事件冒泡到 window,
// App 全局监听又 setRoot(源文件夹)→ 文件刚复制进旧 workspace,窗口就切走了。
// 注意不能用「App 监听判 defaultPrevented」修:dockview 根 Droptarget 的 drop 无条件 preventDefault
//(无 overlay state 也一样),那样会把拖到 dock 区域「打开为 workspace」一并打断 —— 下方第二组用真实
// DockviewReact 钉住这一点。
import React from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { DockviewReact } from 'dockview-react';
import type { FileEntry } from '../../lib/fs/types';

const h = vi.hoisted(() => ({
  Null: () => null,
  dropInto: vi.fn(async (..._args: unknown[]) => {}),
  listDir: vi.fn(),
  focusWorkspaceWindow: vi.fn(async (_root: string) => ({ ok: true, data: false })),
}));

const treeFiles: FileEntry[] = [
  { path: '/work/dir', name: 'dir', isDirectory: true },
  { path: '/work/f0.ts', name: 'f0.ts', isDirectory: false },
];
h.listDir.mockImplementation(async (p: string) => ({
  ok: true,
  data: p === '/work' ? treeFiles : [],
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    window: {
      notifyRoot: vi.fn(async () => ({ ok: true })),
      getPathForFile: () => '/src-folder',
      focusWorkspaceWindow: h.focusWorkspaceWindow,
      onMenuCommand: () => () => {}, setMenuKeybindings: async () => ({ ok: true }),
    },
    fs: {
      listDir: h.listDir,
      move: vi.fn(),
      copy: vi.fn(),
      trash: vi.fn(),
      reveal: vi.fn(),
      writeBinary: vi.fn(async () => ({ ok: true })),
      watchDir: vi.fn(async () => ({ ok: true })),
      unwatchDir: vi.fn(async () => ({ ok: true })),
      onDirChanged: vi.fn(() => vi.fn()),
      onWatchLost: vi.fn(() => vi.fn()),
      onRootPresenceChanged: vi.fn(() => vi.fn()),
    },
    terminal: { create: vi.fn() },
  },
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getTotalSize: () => opts.count * 28,
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: () => {},
  }),
}));
vi.mock('@/panels/Editor/useEditorFile', () => {
  const editorFile = { openFileByPath: async () => ({ ok: true }) };
  return { useEditorFile: () => editorFile };
});
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('../../panels/Explorer/batch-transfer', async (orig) => ({
  ...(await orig<typeof import('../../panels/Explorer/batch-transfer')>()),
  dropForeignFilesInto: h.dropInto,
}));
vi.mock('../../panels/Explorer/ExplorerHeader', () => ({ ExplorerHeader: () => null }));

// 壳:Explorer 侧栏 = 真实 FolderTree;Dock 区 = 真实 DockviewReact(其根 Droptarget 行为是回归点)
vi.mock('../../shell/ExplorerSidebar', async () => {
  const { FolderTree } = await import('../../panels/Explorer/FolderTree');
  return {
    ExplorerSidebar: () => (
      <aside data-testid="explorer">
        <FolderTree root="/work" />
      </aside>
    ),
  };
});
vi.mock('../../shell/dock/DockShell', () => ({
  DockShell: () => (
    <div data-testid="dock" style={{ width: 800, height: 600 }}>
      <DockviewReact components={{}} onReady={() => {}} />
    </div>
  ),
}));
vi.mock('../../shell/dock/TerminalSessionsSync', () => ({ TerminalSessionsSync: h.Null }));
vi.mock('../../shell/IconSidebar', () => ({ IconSidebar: h.Null }));
vi.mock('../../shell/StatusBar', () => ({ StatusBar: h.Null }));
vi.mock('../../shell/TitleBar', () => ({ TitleBar: h.Null }));
vi.mock('../../shell/AgentAuthPrompt', () => ({ AgentAuthPrompt: h.Null }));
vi.mock('@/plugins/command-palette/CommandPalette', () => ({ CommandPalette: h.Null }));
vi.mock('@/plugins/command-palette/useCommandPaletteHotkey', () => ({
  useCommandPaletteHotkey: () => {},
}));
vi.mock('@/plugins/command-palette/useCommandHotkeys', () => ({ useCommandHotkeys: () => {} }));
vi.mock('@/panels/Editor/useExternalFileSync', () => ({ useExternalFileSync: () => {} }));
vi.mock('@/panels/Editor/useExternalSyncRootWatch', () => ({ useExternalSyncRootWatch: () => {} }));
vi.mock('@/plugins/quick-open/QuickOpenModal', () => ({ QuickOpenModal: h.Null }));
vi.mock('@/plugins/quick-open/useQuickOpenHotkey', () => ({ useQuickOpenHotkey: () => {} }));
vi.mock('@/plugins/permissions/PermissionPrompt', () => ({ PermissionPrompt: h.Null }));
vi.mock('@/lib/popout-mode', () => ({ isPopoutWindow: () => false }));
vi.mock('@/theme', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
  useTheme: () => ({ resolved: 'dark' }),
}));
vi.mock('@/plugins/settings/LanguageFromSettings', () => ({ LanguageFromSettings: h.Null }));
vi.mock('@/notifications/ToastViewport', () => ({ ToastViewport: h.Null }));
vi.mock('@/notifications/NotificationsProvider', () => ({
  NotificationsProvider: ({ children }: { children: ReactNode }) => children,
}));

import { App } from '../../shell/App';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useExplorerStore } from '@/stores/explorer.store';

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/** Finder 拖入单个文件夹:types 含 Files,items 可 webkitGetAsEntry 判定为目录。 */
const folderDT = () => ({
  types: ['Files'],
  items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }],
  files: [new File([], 'src-folder')],
});
const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 30)));

beforeEach(() => {
  h.dropInto.mockClear();
  useExplorerStore.setState({ expandedPaths: new Set(), sort: { by: 'name', reverse: false } });
  useWorkspaceStore.setState({ root: '/work', recentRoots: [] });
});
afterEach(() => cleanup());

async function mount() {
  const r = render(<App />);
  await waitFor(() => expect(r.container.querySelector('[title="/work/f0.ts"]')).not.toBeNull());
  return r;
}

describe('拖文件夹:Explorer 文件树内只复制,不切换 workspace', () => {
  it('落在文件树空白处 → Explorer 复制一次,workspace 仍为原 root', async () => {
    const { container } = await mount();
    const blank = container.querySelector('[data-testid="explorer"] .overflow-auto') as HTMLElement;
    await act(async () => {
      fireEvent.drop(blank, { dataTransfer: folderDT() });
    });
    await flush();
    expect(h.dropInto).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().root).toBe('/work');
  });

  it('落在 [role=tree] 容器本身(headless-tree 容器级 drop)→ 复制一次,workspace 不变', async () => {
    const { container } = await mount();
    await act(async () => {
      fireEvent.drop(container.querySelector('[role="tree"]')!, { dataTransfer: folderDT() });
    });
    await flush();
    expect(h.dropInto).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().root).toBe('/work');
  });
});

describe('拖文件夹:Explorer 以外区域 → 仍打开为 workspace', () => {
  it('落在 dockview 区域(其根 Droptarget 会 preventDefault)→ workspace 切到该文件夹', async () => {
    const { container } = await mount();
    const dockRoot = container.querySelector('[data-testid="dock"] .dv-dockview') as HTMLElement;
    expect(dockRoot).not.toBeNull();
    await act(async () => {
      fireEvent.drop(dockRoot, { dataTransfer: folderDT() });
    });
    await waitFor(() => expect(useWorkspaceStore.getState().root).toBe('/src-folder'));
    expect(h.dropInto).not.toHaveBeenCalled();
  });

  it('落在窗口其他空白处(主布局容器)→ workspace 切到该文件夹', async () => {
    const { container } = await mount();
    await act(async () => {
      fireEvent.drop(container.querySelector('main')!, { dataTransfer: folderDT() });
    });
    await waitFor(() => expect(useWorkspaceStore.getState().root).toBe('/src-folder'));
    expect(h.dropInto).not.toHaveBeenCalled();
  });
});

describe('拖文件夹:该文件夹已在别的窗口打开', () => {
  it('落在 Explorer 以外 → main 聚焦那个窗口,本窗口 workspace 不变(VSCode 同)', async () => {
    h.focusWorkspaceWindow.mockResolvedValueOnce({ ok: true, data: true });
    const { container } = await mount();
    await act(async () => {
      fireEvent.drop(container.querySelector('main')!, { dataTransfer: folderDT() });
    });
    await waitFor(() => expect(h.focusWorkspaceWindow).toHaveBeenCalledWith('/src-folder'));
    await flush();
    expect(useWorkspaceStore.getState().root).toBe('/work');
  });
});
