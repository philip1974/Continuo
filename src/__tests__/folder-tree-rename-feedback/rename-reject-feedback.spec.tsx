// @vitest-environment jsdom
// a11y(A133,A50 同族):inline rename 的 fire-and-forget async 只处理 renameItem 返回 ok:false,
// 未 catch IPC reject → 键盘用户重命名异常时静默失败无反馈。须 try/catch + notify.error。
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { TreeConfig } from '@headless-tree/core';
import type { FileEntry } from '../../lib/fs/types';

const h = vi.hoisted(() => ({
  useTree: vi.fn(),
  renameItem: vi.fn(),
  notifyError: vi.fn(),
  contextActions: { current: null as Record<string, unknown> | null },
  dnd: { current: null as { draggedItems: Array<{ getId: () => string }> } | null },
  openFileByPath: vi.fn(async () => ({ ok: true })),
  items: { current: [] as unknown[] },
  virtualItems: {
    current: [] as Array<{ index: number; start: number; size: number; key: number }>,
  },
}));

vi.mock('@headless-tree/react', () => ({ useTree: h.useTree }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getTotalSize: () => h.virtualItems.current.length * 24,
    getVirtualItems: () => h.virtualItems.current,
  }),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      listDir: vi.fn(async () => ({ ok: true, data: [] })),
      move: vi.fn(),
      copy: vi.fn(),
      trash: vi.fn(),
      reveal: vi.fn(),
      watchDir: vi.fn(async () => ({ ok: true })),
      unwatchDir: vi.fn(async () => ({ ok: true })),
      onDirChanged: vi.fn(() => vi.fn()),
    },
    terminal: { create: vi.fn() },
  },
}));
vi.mock('@/panels/Editor/useEditorFile', () => ({
  useEditorFile: () => ({ openFileByPath: h.openFileByPath }),
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: (_key: string, fallback: unknown) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('@/notifications/notify', () => ({ notify: { error: h.notifyError } }));
vi.mock('../../panels/Explorer/mutate-actions', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, renameItem: h.renameItem };
});
// 捕获下传给 ContextMenu 的 actions(含 onPaste),用于 A135 paste reject 测试。
vi.mock('../../panels/Explorer/ContextMenu', () => ({
  ContextMenu: ({
    children,
    actions,
  }: {
    children?: React.ReactNode;
    actions: Record<string, unknown>;
  }) => {
    h.contextActions.current = actions;
    return children ?? null;
  },
}));

import { FolderTree } from '../../panels/Explorer/FolderTree';
import { useExplorerClipboardStore } from '../../panels/Explorer/clipboard-store';

function fakeTree(config: TreeConfig<FileEntry>) {
  // 暴露 config 给测试取 onRename。
  (fakeTree as unknown as { lastConfig?: TreeConfig<FileEntry> }).lastConfig = config;
  return {
    getItems: () => h.items.current,
    getState: () => ({
      selectedItems: [],
      expandedItems: [],
      dnd: h.dnd.current,
    }),
    getContainerProps: () => ({}),
    getItemInstance: () => ({ invalidateChildrenIds: vi.fn(), startRenaming: vi.fn() }),
    rebuildTree: vi.fn(),
    expandAll: vi.fn(),
    collapseAll: vi.fn(),
  };
}

beforeEach(() => {
  h.renameItem.mockReset();
  h.notifyError.mockReset();
  h.useTree.mockReset();
  h.useTree.mockImplementation(fakeTree);
  h.dnd.current = null;
  h.contextActions.current = null;
  h.openFileByPath.mockReset();
  h.openFileByPath.mockResolvedValue({ ok: true });
  h.items.current = [];
  h.virtualItems.current = [];
});

afterEach(() => cleanup());

describe('a11y(A133) — inline rename reject 须 notify.error', () => {
  function getOnRename() {
    render(React.createElement(FolderTree, { root: '/repo' }));
    const config = (fakeTree as unknown as { lastConfig?: TreeConfig<FileEntry> })
      .lastConfig;
    return config?.onRename as
      | ((item: { getId: () => string }, name: string) => void)
      | undefined;
  }

  it('renameItem reject → notify.error', async () => {
    h.renameItem.mockRejectedValue(new Error('ipc down'));
    const onRename = getOnRename();
    expect(onRename).toBeTypeOf('function');
    onRename!({ getId: () => '/repo/a.txt' }, 'b.txt');
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });

  it('renameItem {ok:false} → notify.error(既有行为保持)', async () => {
    h.renameItem.mockResolvedValue({ ok: false, code: 'FS_EEXIST' });
    const onRename = getOnRename();
    onRename!({ getId: () => '/repo/a.txt' }, 'b.txt');
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });
});

// a11y(A134,A133 同族):内部多选拖动 onDropItems 的 fire-and-forget async,
// move IPC reject 与 makeUniqueDestPicker(目标名探测)reject 此前无 catch → 静默无反馈。
describe('a11y(A134) — onDropItems reject 须 notify.error', () => {
  // config 暴露的是 onDrop(items, target);内部经 resolveDest → onDropItems(items, destDir)。
  // 目标为文件夹时 destDir = target.item.getId()。
  function getOnDrop() {
    render(React.createElement(FolderTree, { root: '/repo' }));
    const config = (fakeTree as unknown as { lastConfig?: TreeConfig<FileEntry> })
      .lastConfig;
    return config?.onDrop as
      | ((items: Array<{ getId: () => string }>, target: unknown) => void)
      | undefined;
  }
  const folderTarget = (id: string) => ({
    item: { isFolder: () => true, getId: () => id },
  });

  it('coApi.fs.move reject → notify.error', async () => {
    const { coApi } = (await import('@/lib/co-api')) as unknown as {
      coApi: { fs: { move: ReturnType<typeof vi.fn> } };
    };
    coApi.fs.move.mockRejectedValue(new Error('ipc down'));
    const onDrop = getOnDrop();
    expect(onDrop).toBeTypeOf('function');
    onDrop!([{ getId: () => '/repo/a.txt' }], folderTarget('/repo/sub'));
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });

  it('makeUniqueDestPicker(listDir)reject → notify.error', async () => {
    const { coApi } = (await import('@/lib/co-api')) as unknown as {
      coApi: { fs: { move: ReturnType<typeof vi.fn>; listDir: ReturnType<typeof vi.fn> } };
    };
    coApi.fs.move.mockResolvedValue({ ok: true });
    coApi.fs.listDir.mockRejectedValueOnce(new Error('listDir down'));
    const onDrop = getOnDrop();
    onDrop!([{ getId: () => '/repo/a.txt' }], folderTarget('/repo/sub'));
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });
});

// a11y(A135,A134/A133 同族):剪贴板 onPaste(cut→move / copy)的 fire-and-forget async,
// move/copy IPC reject 与 makeUniqueDestPicker(目标名探测,try 外)reject 此前无 catch → 静默无反馈。
describe('a11y(A135) — onPaste reject 须 notify.error', () => {
  function getOnPaste() {
    render(React.createElement(FolderTree, { root: '/repo' }));
    return h.contextActions.current?.onPaste as ((destDir: string) => void) | undefined;
  }

  it('cut→coApi.fs.move reject → notify.error', async () => {
    const { coApi } = (await import('@/lib/co-api')) as unknown as {
      coApi: { fs: { move: ReturnType<typeof vi.fn> } };
    };
    coApi.fs.move.mockRejectedValue(new Error('ipc down'));
    useExplorerClipboardStore.getState().set('cut', ['/repo/a.txt']);
    const onPaste = getOnPaste();
    expect(onPaste).toBeTypeOf('function');
    onPaste!('/repo/sub');
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });

  it('copy→coApi.fs.copy reject → notify.error', async () => {
    const { coApi } = (await import('@/lib/co-api')) as unknown as {
      coApi: { fs: { copy: ReturnType<typeof vi.fn> } };
    };
    coApi.fs.copy.mockRejectedValue(new Error('ipc down'));
    useExplorerClipboardStore.getState().set('copy', ['/repo/a.txt']);
    const onPaste = getOnPaste();
    onPaste!('/repo/sub');
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });

  it('makeUniqueDestPicker(listDir)reject → notify.error', async () => {
    const { coApi } = (await import('@/lib/co-api')) as unknown as {
      coApi: {
        fs: { copy: ReturnType<typeof vi.fn>; listDir: ReturnType<typeof vi.fn> };
      };
    };
    coApi.fs.copy.mockResolvedValue({ ok: true });
    coApi.fs.listDir.mockRejectedValueOnce(new Error('listDir down'));
    useExplorerClipboardStore.getState().set('copy', ['/repo/a.txt']);
    const onPaste = getOnPaste();
    onPaste!('/repo/sub');
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });
});

// a11y(A136,A135/A134/A133 同族):root-drop(拖到空白处)是 async 事件处理器,React 不 await,
// makeUniqueDestPicker(root)(try 外)与 coApi.fs.move 的 IPC reject 此前成 unhandled rejection,无反馈。
describe('a11y(A136) — root-drop reject 须 notify.error', () => {
  function fireRootDrop() {
    const { container } = render(React.createElement(FolderTree, { root: '/repo' }));
    // dnd 内部拖动(types 不含 'Files')→ 走 root-drop 分支;
    // src dirname !== root 才进入 moveable。
    h.dnd.current = { draggedItems: [{ getId: () => '/repo/sub/a.txt' }] };
    fireEvent.drop(container.firstChild as Element, {
      dataTransfer: { types: [] },
    });
  }

  it('coApi.fs.move reject → notify.error', async () => {
    const { coApi } = (await import('@/lib/co-api')) as unknown as {
      coApi: { fs: { move: ReturnType<typeof vi.fn> } };
    };
    coApi.fs.move.mockRejectedValue(new Error('ipc down'));
    fireRootDrop();
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });

  it('makeUniqueDestPicker(listDir)reject → notify.error', async () => {
    const { coApi } = (await import('@/lib/co-api')) as unknown as {
      coApi: { fs: { move: ReturnType<typeof vi.fn>; listDir: ReturnType<typeof vi.fn> } };
    };
    coApi.fs.move.mockResolvedValue({ ok: true });
    coApi.fs.listDir.mockRejectedValueOnce(new Error('listDir down'));
    fireRootDrop();
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });
});

// a11y(A142,A141 同族):点击文件 → handleFileOpen 里 openFileByPath() 只处理 ok:false,
// reject(抛错而非返回 {ok:false})此前未捕获 → 行 onClick fire-and-forget 变 unhandled,无反馈。
describe('a11y(A142) — handleFileOpen openFileByPath reject 须 notify.error', () => {
  function fileItem(path: string, name: string) {
    return {
      getId: () => path,
      getItemData: () => ({ path, name, isDirectory: false }),
      isFolder: () => false,
      isSelected: () => false,
      isFocused: () => false,
      isExpanded: () => false,
      isLoading: () => false,
      isRenaming: () => false,
      isDraggingOver: () => false,
      getItemMeta: () => ({ level: 0 }),
      getProps: () => ({}),
      getRenameInputProps: () => ({}),
    };
  }

  it('openFileByPath reject → notify.error', async () => {
    h.openFileByPath.mockRejectedValue(new Error('open down'));
    h.items.current = [fileItem('/repo/a.txt', 'a.txt')];
    h.virtualItems.current = [{ index: 0, start: 0, size: 24, key: 0 }];
    const { getByText } = render(React.createElement(FolderTree, { root: '/repo' }));
    fireEvent.click(getByText('a.txt'));
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });

  it('openFileByPath {ok:false} → notify.error(既有行为保持)', async () => {
    h.openFileByPath.mockResolvedValue({ ok: false, code: 'FS_ENOENT' } as never);
    h.items.current = [fileItem('/repo/a.txt', 'a.txt')];
    h.virtualItems.current = [{ index: 0, start: 0, size: 24, key: 0 }];
    const { getByText } = render(React.createElement(FolderTree, { root: '/repo' }));
    fireEvent.click(getByText('a.txt'));
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });
});

// a11y(A140,A139 同族):右键「在终端打开」的 fire-and-forget async,coApi.terminal.create()
// 的 IPC reject 此前无 catch → unhandled rejection,失败时无 toast/live region 反馈。
describe('a11y(A140) — onOpenInTerminal reject 须 notify.error', () => {
  it('coApi.terminal.create reject → notify.error', async () => {
    const { coApi } = (await import('@/lib/co-api')) as unknown as {
      coApi: { terminal: { create: ReturnType<typeof vi.fn> } };
    };
    coApi.terminal.create.mockRejectedValue(new Error('spawn down'));
    render(React.createElement(FolderTree, { root: '/repo' }));
    const onOpenInTerminal = h.contextActions.current?.onOpenInTerminal as
      | ((dir: string) => void)
      | undefined;
    expect(onOpenInTerminal).toBeTypeOf('function');
    onOpenInTerminal!('/repo/sub');
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });
});

// a11y(A148):tree dataLoader 的 listDir 失败,FolderTree 现传 onIpcWarn → console.warn + 限流
// notify.error(此前 FolderTree 未传 → 仅 console.warn 静默)。经真实 config.dataLoader 触发。
// 放最后:本用例把 coApi.fs.listDir 设为失败,后续无其他用例依赖 listDir 默认 ok。
describe('a11y(A148) — tree listDir 失败须限流 notify', () => {
  async function getDataLoader() {
    render(React.createElement(FolderTree, { root: '/repo' }));
    const config = (fakeTree as unknown as { lastConfig?: TreeConfig<FileEntry> })
      .lastConfig as unknown as {
      dataLoader: { getChildrenWithData: (id: string) => Promise<unknown> };
    };
    return config.dataLoader;
  }

  it('dataLoader listDir {ok:false} → notify.error', async () => {
    const { coApi } = (await import('@/lib/co-api')) as unknown as {
      coApi: { fs: { listDir: ReturnType<typeof vi.fn> } };
    };
    coApi.fs.listDir.mockResolvedValue({ ok: false, code: 'FS_DENIED', message: 'no perm' });
    const loader = await getDataLoader();
    await loader.getChildrenWithData('/repo');
    expect(h.notifyError).toHaveBeenCalledTimes(1);
  });

  it('连续多次 listDir 失败 → 3s 限流只提示一次', async () => {
    const { coApi } = (await import('@/lib/co-api')) as unknown as {
      coApi: { fs: { listDir: ReturnType<typeof vi.fn> } };
    };
    coApi.fs.listDir.mockResolvedValue({ ok: false, code: 'FS_DENIED', message: 'no perm' });
    const loader = await getDataLoader();
    await loader.getChildrenWithData('/repo');
    await loader.getChildrenWithData('/repo/a');
    await loader.getChildrenWithData('/repo/b');
    expect(h.notifyError).toHaveBeenCalledTimes(1);
  });
});

// a11y(A150,A141 同族):row 级外部文件 drop(onDropForeignDragObject → onDropForeign)的
// fire-and-forget async 须 catch —— partitionDropItems / refreshParent 抛会成 unhandled rejection。
describe('a11y(A150) — onDropForeign reject 须 notify.error', () => {
  it('partitionDropItems 抛 → catch notify.error', async () => {
    render(React.createElement(FolderTree, { root: '/repo' }));
    const config = (fakeTree as unknown as { lastConfig?: TreeConfig<FileEntry> })
      .lastConfig as unknown as {
      onDropForeignDragObject?: (dt: unknown, target: unknown) => void;
    };
    const onDropForeign = config.onDropForeignDragObject;
    expect(onDropForeign).toBeTypeOf('function');
    // items.length getter 抛 → partitionDropItems 抛 → 进 catch。
    const badItems = new Proxy([] as unknown[], {
      get(t, p) {
        if (p === 'length') throw new Error('items boom');
        return (t as Record<string | symbol, unknown>)[p];
      },
    });
    onDropForeign!({ items: badItems } as unknown, {
      item: { isFolder: () => true, getId: () => '/repo/sub' },
    });
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });
});

// a11y(A151,A150 同族):空白/root 区域外部文件 drop(handleDrop 外部分支,容器 onDrop)是 async
// 事件处理器,partitionDropItems/refreshParent 抛须 catch,否则 unhandled rejection + 无反馈。
describe('a11y(A151) — handleDrop 外部文件分支 reject 须 notify.error', () => {
  it('partitionDropItems 抛 → catch notify.error', async () => {
    const { container } = render(React.createElement(FolderTree, { root: '/repo' }));
    // 外部文件分支:types 含 'Files';items.length getter 抛 → partitionDropItems 抛 → catch。
    const badItems = new Proxy([] as unknown[], {
      get(t, p) {
        if (p === 'length') throw new Error('items boom');
        return (t as Record<string | symbol, unknown>)[p];
      },
    });
    fireEvent.drop(container.firstChild as Element, {
      dataTransfer: { types: ['Files'], items: badItems },
    });
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });
});
