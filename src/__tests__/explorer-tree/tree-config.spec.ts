// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  asyncDataLoaderFeature,
  createTree,
  syncDataLoaderFeature,
  expandAllFeature,
  hotkeysCoreFeature,
  renamingFeature,
  selectionFeature,
} from '@headless-tree/core';
import {
  buildTreeChildrenWithData,
  createDataLoader,
  createTreeConfig,
  findFileEntryByPath,
  sameTreeChildren,
} from '../../panels/Explorer/tree-config';
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

  // IME:重命名框里拼音 / 日文组合中按 Enter 是确认候选词、Esc 是取消组合 —— headless-tree 的
  // completeRenaming / abortRenaming 只按 e.code 匹配,不看 isComposing,须由 hotkeys 覆盖拦下。
  describe('重命名热键在 IME 组合中不提交 / 不取消', () => {
    function mountRenamingTree() {
      const cfg = createTreeConfig({ root: '/work', fs: makeFs(() => ok([])) });
      const onRename = vi.fn();
      const tree = createTree<FileEntry>({
        rootItemId: '/work',
        getItemName: (item) => item.getItemData().name,
        isItemFolder: (item) => item.getItemData().isDirectory,
        dataLoader: {
          getItem: (id) => entry(id, id === '/work'),
          getChildren: (id) => (id === '/work' ? ['/work/a.ts'] : []),
        },
        initialState: { expandedItems: ['/work'] },
        features: [syncDataLoaderFeature, hotkeysCoreFeature, renamingFeature],
        hotkeys: cfg.hotkeys,
        onRename,
      });
      tree.setMounted(true);
      tree.rebuildTree();
      const el = document.createElement('div');
      document.body.appendChild(el);
      tree.registerElement(el);
      tree.getItemInstance('/work/a.ts').startRenaming();
      // 按键发在树内的重命名输入框上(与真实场景一致:hotkeys-core 对 input 目标不残留 pressedKeys)。
      const input = document.createElement('input');
      el.appendChild(input);
      const key = (k: string, init: KeyboardEventInit = {}) =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true, ...init }));
      return { tree, onRename, key, el };
    }

    it('组合中 Enter(isComposing / keyCode 229)→ 不提交;普通 Enter → 提交', () => {
      const { tree, onRename, key } = mountRenamingTree();
      key('Enter', { isComposing: true });
      key('Enter', { keyCode: 229 });
      expect(onRename).not.toHaveBeenCalled();
      expect(tree.isRenamingItem()).toBe(true);
      key('Enter');
      expect(onRename).toHaveBeenCalledTimes(1);
      expect(tree.isRenamingItem()).toBe(false);
    });

    it('组合中 Escape → 不中止重命名;普通 Escape → 中止', () => {
      const { tree, onRename, key } = mountRenamingTree();
      key('Escape', { isComposing: true });
      expect(tree.isRenamingItem()).toBe(true);
      key('Escape');
      expect(tree.isRenamingItem()).toBe(false);
      expect(onRename).not.toHaveBeenCalled();
    });
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

  it('受控 expandedItems 接入不通过条件对象 spread 分配空对象', () => {
    const src = createTreeConfig.toString();

    expect(src).not.toContain('...(deps.expandedItems');
    expect(src).not.toContain(': {})');
    expect(src).toContain('config.state =');
  });
});

describe('createTreeConfig · getItem', () => {
  it('findFileEntryByPath 单趟扫描,不调用 entries.find', () => {
    const entries = [entry('/work/a.md'), entry('/work/b.md')];
    const findSpy = vi.spyOn(entries, 'find');

    try {
      expect(findFileEntryByPath(entries, '/work/b.md')).toBe(entries[1]);
      expect(findFileEntryByPath(entries, '/work/missing.md')).toBeNull();
      expect(findSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

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
  it('FileEntry[] 包装为 tree children 时单趟扫描,不调用 entries.map', () => {
    const entries = [entry('/work/sub', true), entry('/work/a.md')];
    const mapSpy = vi.spyOn(entries, 'map');

    try {
      expect(buildTreeChildrenWithData(entries)).toEqual([
        { id: '/work/sub', data: entries[0] },
        { id: '/work/a.md', data: entries[1] },
      ]);
      expect(mapSpy).not.toHaveBeenCalled();
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('FileEntry[] 包装为 tree children 时预分配数组,不通过 push 扩容', () => {
    const entries = [entry('/work/sub', true), entry('/work/a.md')];

    expect(buildTreeChildrenWithData(entries)).toEqual([
      { id: '/work/sub', data: entries[0] },
      { id: '/work/a.md', data: entries[1] },
    ]);
    expect(buildTreeChildrenWithData.toString()).not.toContain('.push(');
  });

  it('空 FileEntry[] 包装为稳定空 children', () => {
    expect(buildTreeChildrenWithData([])).toEqual([]);
    expect(buildTreeChildrenWithData([])).toBe(buildTreeChildrenWithData([]));
  });

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
    await expect(loader.getChildrenWithData('/work/missing')).resolves.toBe(
      children,
    );
    expect(onIpcWarn).toHaveBeenCalledWith(
      expect.stringContaining('/work/missing'),
      'FS_NOT_FOUND',
    );
  });

  it('每次加载结果回报 onChildrenLoad:成功 null,失败带 code / message(区分读取失败与空目录)', async () => {
    const onChildrenLoad = vi.fn();
    let result: IpcResult<readonly FileEntry[]> = ok([]);
    const fs = makeFs(() => result);
    const loader = createDataLoader({ root: '/work', fs, onIpcWarn: () => {}, onChildrenLoad });
    await loader.getChildrenWithData('/work');
    expect(onChildrenLoad).toHaveBeenLastCalledWith('/work', null);
    result = fail('FS_EACCES', 'permission denied');
    await loader.getChildrenWithData('/work');
    expect(onChildrenLoad).toHaveBeenLastCalledWith('/work', {
      code: 'FS_EACCES',
      message: 'permission denied',
    });
  });

  it('listDir 抛异常 → onChildrenLoad 回报 IPC_HANDLER_ERROR', async () => {
    const onChildrenLoad = vi.fn();
    const fs = {
      listDir: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const loader = createDataLoader({ root: '/work', fs, onIpcWarn: () => {}, onChildrenLoad });
    await loader.getChildrenWithData('/work');
    expect(onChildrenLoad).toHaveBeenCalledWith('/work', { code: 'IPC_HANDLER_ERROR', message: 'boom' });
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
    await expect(loader.getChildrenWithData('/work')).resolves.toBe(children);
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

  // 跨平台(复查 P2):canDrop 自身/子树防护走 path-cross.isSameOrInsidePath(运行时
  // 大小写)。Windows 上源/目标仅大小写不同应仍拦 move-into-descendant。
  it('canDrop:Windows 大小写不敏感 → 拦仅大小写不同的子树 drop', () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', {
      value: 'Win32',
      configurable: true,
    });
    try {
      const fs = makeFs(() => ok([]));
      const cfg = createTreeConfig({ root: 'C:\\work', fs });
      const dir = mkItem('C:\\work\\dir', true);
      expect(cfg.canDrop!([dir], mkTarget('c:\\WORK\\Dir\\sub', true))).toBe(
        false,
      );
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
      else delete (navigator as { platform?: string }).platform;
    }
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

  // 边界(E225,E224 兄弟):canDrop 复用共享早停 hasFiles(非裸 types.includes),命中即短路不全量扫描。
  it('E225 canDropForeignDragObject 用早停 hasFiles(命中 Files 后不遍历后续 types)', () => {
    const fs = makeFs(() => ok([]));
    const cfg = createTreeConfig({ root: '/x', fs });
    const types = ['Files'] as string[];
    Object.defineProperty(types, 'length', { value: 2 });
    Object.defineProperty(types, 1, {
      get() {
        throw new Error('E225 regression: 命中 Files 后仍遍历后续 types');
      },
    });
    expect(
      cfg.canDropForeignDragObject!({ types } as never, mkTarget('/x', true)),
    ).toBe(true);
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

describe('sameTreeChildren · 目录刷新比对', () => {
  const a = entry('/w/a', true);
  const b: FileEntry = { ...entry('/w/b.md'), size: 1, mtime: 1 };
  const cache = (es: FileEntry[]) => ({
    ids: es.map((e) => e.path),
    data: Object.fromEntries(es.map((e) => [e.path, e])) as Record<string, FileEntry>,
  });
  const same = (old: FileEntry[], next: FileEntry[]) => {
    const c = cache(old);
    return sameTreeChildren(c.ids, c.data, next);
  };

  it('完全相同 → true;只差 size / mtime / ctime → true', () => {
    expect(same([a, b], [a, b])).toBe(true);
    expect(same([a, b], [a, { ...b, size: 2, mtime: 2, ctime: 2 }])).toBe(true);
    expect(same([], [])).toBe(true);
  });

  it('新增 / 删除 / 改名 / 顺序变化 → false', () => {
    expect(same([a], [a, b])).toBe(false);
    expect(same([a, b], [a])).toBe(false);
    expect(same([a, b], [a, entry('/w/c.md')])).toBe(false);
    expect(same([a, b], [b, a])).toBe(false);
  });

  it('name / isDirectory / isSymlink 变化 → false;isSymlink 缺省与 false 等价', () => {
    expect(same([a, b], [a, { ...b, name: 'B.md' }])).toBe(false);
    expect(same([a, b], [a, { ...b, isDirectory: true }])).toBe(false);
    expect(same([a, b], [a, { ...b, isSymlink: true }])).toBe(false);
    expect(same([a, b], [a, { ...b, isSymlink: false }])).toBe(true);
  });

  it('缓存缺该子项数据 → false', () => {
    expect(sameTreeChildren(['/w/a'], {}, [a])).toBe(false);
  });
});
