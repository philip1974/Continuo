import { describe, it, expect, vi } from 'vitest';
import {
  asyncDataLoaderFeature,
  expandAllFeature,
  hotkeysCoreFeature,
  renamingFeature,
  selectionFeature,
} from '@headless-tree/core';
import { createDataLoader, createTreeConfig } from '../../panels/Explorer/tree-config';
import type { FileEntry, IpcResult } from '../../lib/fs/types';

const ok = <T,>(data: T): IpcResult<T> => ({ ok: true, data });
const fail = (code: string, message = code): IpcResult<never> => ({
  ok: false,
  code,
  message,
});

const entry = (path: string, isDirectory = false, name?: string): FileEntry => ({
  path,
  name: name ?? path.split('/').pop()!,
  isDirectory,
});

const makeFs = (impl: (path: string) => IpcResult<readonly FileEntry[]>) => ({
  listDir: vi.fn(async (path: string) => impl(path)),
});

describe('createTreeConfig · 顶层配置', () => {
  it('rootItemId 等于传入 root', () => {
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/work', fs });
    expect(cfg.rootItemId).toBe('/work');
  });

  it('features 包含 asyncDataLoader / selection / hotkeysCore / renaming / expandAll', () => {
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/work', fs });
    expect(cfg.features).toContain(asyncDataLoaderFeature);
    expect(cfg.features).toContain(selectionFeature);
    expect(cfg.features).toContain(hotkeysCoreFeature);
    expect(cfg.features).toContain(renamingFeature);
    expect(cfg.features).toContain(expandAllFeature);
  });

  it('onRename 透传到 config(headless-tree renamingFeature 触发)', () => {
    const fs = makeFs(() => ok([]));
    const onRename = () => {};
    const cfg = createTreeConfig({ root: '/work', fs, onRename });
    expect(cfg.onRename).toBe(onRename);
  });

  it('indent 为 16(VSCode 默认风格)', () => {
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/work', fs });
    expect(cfg.indent).toBe(16);
  });

  it('initialState.expandedItems 包含 root(否则 getItems 返空)', () => {
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/work', fs });
    expect(cfg.initialState?.expandedItems).toContain('/work');
  });
});

describe('createTreeConfig · getItem', () => {
  it('itemId === root → 构造 root entry,name = basename(root)', async () => {
    const fs = makeFs(() => ok([]));
    const loader = createDataLoader({ root: '/Users/me/work', fs });
    const item = await loader.getItem('/Users/me/work');
    expect(item).toEqual({
      path: '/Users/me/work',
      name: 'work',
      isDirectory: true,
    });
    // root 不应该触发 listDir(无父目录可查)
    expect(fs.listDir).not.toHaveBeenCalled();
  });

  it('itemId === root 且 root 以斜杠结尾 → basename 仍正确', async () => {
    const fs = makeFs(() => ok([]));
    const loader = createDataLoader({ root: '/Users/me/work/', fs });
    const item = await loader.getItem('/Users/me/work/');
    expect(item.name).toBe('work');
  });

  it('itemId 非 root → 调 listDir(parent) 查找', async () => {
    const target = entry('/work/file.md');
    const fs = makeFs((p) => (p === '/work' ? ok([target]) : ok([])));
    const loader = createDataLoader({ root: '/work', fs });
    const item = await loader.getItem('/work/file.md');
    expect(item).toEqual(target);
    expect(fs.listDir).toHaveBeenCalledWith('/work');
  });

  it('itemId 非 root 且 listDir 失败 → 返回兜底最小 entry', async () => {
    const onIpcWarn = vi.fn();
    const fs = makeFs(() => fail('FS_DENIED', 'no perm'));
    const loader = createDataLoader({ root: '/work', fs, onIpcWarn });
    const item = await loader.getItem('/work/secret.txt');
    expect(item).toEqual({
      path: '/work/secret.txt',
      name: 'secret.txt',
      isDirectory: false,
    });
    expect(onIpcWarn).toHaveBeenCalled();
  });
});

describe('createDataLoader · getChildrenWithData', () => {
  it('成功 → 把 FileEntry[] 映射为 { id, data }[]', async () => {
    const sub = entry('/work/sub', true);
    const md = entry('/work/a.md');
    const fs = makeFs(() => ok([sub, md]));
    const loader = createDataLoader({ root: '/work', fs });
    const children = await loader.getChildrenWithData('/work');
    expect(children).toEqual([
      { id: '/work/sub', data: sub },
      { id: '/work/a.md', data: md },
    ]);
    expect(fs.listDir).toHaveBeenCalledWith('/work');
  });

  it('IpcFail → 返回 [] 不抛', async () => {
    const onIpcWarn = vi.fn();
    const fs = makeFs(() => fail('FS_NOT_FOUND', 'gone'));
    const loader = createDataLoader({ root: '/work', fs, onIpcWarn });
    const children = await loader.getChildrenWithData('/work/missing');
    expect(children).toEqual([]);
    expect(onIpcWarn).toHaveBeenCalledWith(
      expect.stringContaining('/work/missing'),
      'FS_NOT_FOUND',
    );
  });

  it('listDir 抛异常 → 也被吞,返回 []', async () => {
    const onIpcWarn = vi.fn();
    const fs = {
      listDir: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const loader = createDataLoader({ root: '/work', fs, onIpcWarn });
    const children = await loader.getChildrenWithData('/work');
    expect(children).toEqual([]);
    expect(onIpcWarn).toHaveBeenCalled();
  });

  it('默认 onIpcWarn 走 console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fs = makeFs(() => fail('FS_IO', 'disk'));
      const loader = createDataLoader({ root: '/x', fs });
      await loader.getChildrenWithData('/x');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('createTreeConfig · getItemName / isItemFolder', () => {
  // ItemInstance 真实形态复杂,这里用最小 mock 验证函数逻辑
  const makeItem = (data: FileEntry) => ({ getItemData: () => data });

  it('getItemName 返回 data.name', () => {
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/x', fs });
    expect(cfg.getItemName!(makeItem(entry('/x/a.md')) as never)).toBe('a.md');
  });

  it('isItemFolder 返回 data.isDirectory', () => {
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/x', fs });
    expect(cfg.isItemFolder!(makeItem(entry('/x/sub', true)) as never)).toBe(true);
    expect(cfg.isItemFolder!(makeItem(entry('/x/a')) as never)).toBe(false);
  });
});

describe('createTreeConfig · 拖拽语义', () => {
  // mock ItemInstance 形态(只用 isFolder / getId / getItemData)
  function mkItem(id: string, isFolder: boolean) {
    return {
      getId: () => id,
      isFolder: () => isFolder,
      getItemData: () => entry(id, isFolder),
    } as unknown as never;
  }

  function mkTarget(id: string, isFolder: boolean) {
    return {
      item: mkItem(id, isFolder),
      childIndex: null,
      insertionIndex: null,
      dragLineIndex: null,
    } as never;
  }

  it('canDrop:drop 到自身 → false', () => {
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/work', fs });
    const a = mkItem('/work/a', true);
    expect(cfg.canDrop!([a], mkTarget('/work/a', true))).toBe(false);
  });

  it('canDrop:目录 drop 到自身子树 → false', () => {
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/work', fs });
    const dir = mkItem('/work/dir', true);
    // 目标是 dir 的子目录
    expect(cfg.canDrop!([dir], mkTarget('/work/dir/sub', true))).toBe(false);
  });

  it('canDrop:文件 drop 到目录 → true', () => {
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/work', fs });
    const file = mkItem('/work/a.txt', false);
    expect(cfg.canDrop!([file], mkTarget('/work/dir', true))).toBe(true);
  });

  it('canDrop:文件 drop 到另一文件(自动归一到父目录) → true 当父目录不同', () => {
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/work', fs });
    const file = mkItem('/work/src/a.txt', false);
    // 拖到 /work/dest/b.txt → 父目录 /work/dest,不同 → true
    expect(cfg.canDrop!([file], mkTarget('/work/dest/b.txt', false))).toBe(
      true,
    );
  });

  it('onDrop → 调 onDropItems(items, resolveDest)', () => {
    const onDropItems = vi.fn();
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/work', fs, onDropItems });
    const file = mkItem('/work/a.txt', false);
    cfg.onDrop!([file], mkTarget('/work/dir', true));
    // dest = '/work/dir'(目标是目录,resolveDest 返目标自身)
    expect(onDropItems).toHaveBeenCalledWith([file], '/work/dir');
  });

  it('onDrop → 拖到文件:dest 是父目录', () => {
    const onDropItems = vi.fn();
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/work', fs, onDropItems });
    const src = mkItem('/work/a.txt', false);
    cfg.onDrop!([src], mkTarget('/work/dest/b.txt', false));
    expect(onDropItems).toHaveBeenCalledWith([src], '/work/dest');
  });

  it('canDropForeignDragObject / canDragForeignDragObjectOver:dataTransfer.types 含 Files → true', () => {
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/x', fs });
    expect(
      cfg.canDropForeignDragObject!(
        { types: ['Files', 'text/plain'] } as never,
        mkTarget('/x', true),
      ),
    ).toBe(true);
    expect(
      cfg.canDragForeignDragObjectOver!(
        { types: ['Files'] } as never,
        mkTarget('/x', true),
      ),
    ).toBe(true);
  });

  it('canDropForeignDragObject:无 Files → false', () => {
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/x', fs });
    expect(
      cfg.canDropForeignDragObject!(
        { types: ['text/plain'] } as never,
        mkTarget('/x', true),
      ),
    ).toBe(false);
  });

  it('onDropForeignDragObject → onDropForeign(dataTransfer, dest)', () => {
    const onDropForeign = vi.fn();
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/x', fs, onDropForeign });
    const dataTransfer = { types: ['Files'] } as never;
    cfg.onDropForeignDragObject!(dataTransfer, mkTarget('/x/sub', true));
    expect(onDropForeign).toHaveBeenCalledWith(dataTransfer, '/x/sub');
  });
});
