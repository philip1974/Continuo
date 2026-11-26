// BDD:资源管理器树拖出时写入的拖动数据,以及接收端的读取 / 判定。见同目录 README「行为 1」。
import { describe, expect, it, vi } from 'vitest';
import type { ItemInstance, TreeInstance } from '@headless-tree/core';
import {
  EXPLORER_DRAG_MIME,
  fileUrlOf,
  hasExplorerDrag,
  readExplorerDragData,
  setExplorerDragData,
} from '@/lib/explorer-drag';
import { hasFiles } from '@/lib/window-drop';
import { createTreeConfig, explorerDragOutFeature } from '@/panels/Explorer/tree-config';
import type { FileEntry } from '@/lib/fs/types';

class FakeDataTransfer {
  readonly store = new Map<string, string>();
  dropEffect = 'none';
  effectAllowed = 'uninitialized';
  get types(): string[] {
    return [...this.store.keys()];
  }
  setData(format: string, data: string): void {
    this.store.set(format, data);
  }
  getData(format: string): string {
    return this.store.get(format) ?? '';
  }
}

const dt = () => new FakeDataTransfer() as unknown as DataTransfer & FakeDataTransfer;

describe('拖动数据', () => {
  it('写入自定义 MIME(含是否文件夹)、file:// URL 列表(CRLF)与换行分隔的路径;不写 Files', () => {
    const d = dt();
    setExplorerDragData(d, [
      { path: '/w/a b.ts', isDirectory: false },
      { path: '/w/src', isDirectory: true },
    ]);
    expect(JSON.parse(d.getData(EXPLORER_DRAG_MIME))).toEqual([
      { path: '/w/a b.ts', isDirectory: false },
      { path: '/w/src', isDirectory: true },
    ]);
    expect(d.getData('text/uri-list')).toBe('file:///w/a%20b.ts\r\nfile:///w/src');
    expect(d.getData('text/plain')).toBe('/w/a b.ts\n/w/src');
    expect(hasFiles(d)).toBe(false);
    expect(hasExplorerDrag(d)).toBe(true);
  });

  it('file URL:特殊字符编码;Windows 盘符与 UNC', () => {
    expect(fileUrlOf('/a/#1 ?.md')).toBe('file:///a/%231%20%3F.md');
    expect(fileUrlOf('/a/中.md')).toBe('file:///a/%E4%B8%AD.md');
    expect(fileUrlOf('C:\\Users\\a b\\x.ts')).toBe('file:///C:/Users/a%20b/x.ts');
    expect(fileUrlOf('\\\\srv\\share\\x.ts')).toBe('file://srv/share/x.ts');
  });

  it('读取:没有自定义 MIME / 非法 JSON / 非数组 → null;非法元素丢弃;超上限计入 overflow', () => {
    expect(readExplorerDragData(null)).toBeNull();
    expect(readExplorerDragData(dt())).toBeNull();
    const bad = dt();
    bad.setData(EXPLORER_DRAG_MIME, '{oops');
    expect(readExplorerDragData(bad)).toBeNull();
    const obj = dt();
    obj.setData(EXPLORER_DRAG_MIME, '{"path":"/a"}');
    expect(readExplorerDragData(obj)).toBeNull();

    const d = dt();
    d.setData(
      EXPLORER_DRAG_MIME,
      JSON.stringify([{ path: '/a' }, null, 3, { path: '' }, { path: 1 }, { path: '/b', isDirectory: true }, { path: '/c' }]),
    );
    expect(readExplorerDragData(d, 2)).toEqual({
      entries: [
        { path: '/a', isDirectory: false },
        { path: '/b', isDirectory: true },
      ],
      overflow: 1,
    });
  });
});

describe('树的 dragstart', () => {
  const entry = (path: string, isDirectory = false): FileEntry => ({ path, name: path.split('/').pop()!, isDirectory });

  function fakeItem(e: FileEntry): ItemInstance<FileEntry> {
    return {
      getId: () => e.path,
      isFolder: () => e.isDirectory,
      getItemData: () => e,
    } as unknown as ItemInstance<FileEntry>;
  }

  function dragStart(item: ItemInstance<FileEntry>, selected: ItemInstance<FileEntry>[], prevented = false) {
    const libDragStart = vi.fn((e: { preventDefault: () => void }) => {
      if (prevented) e.preventDefault();
    });
    const tree = { getSelectedItems: () => selected } as unknown as TreeInstance<FileEntry>;
    const getDragHandleProps = explorerDragOutFeature.itemInstance!.getDragHandleProps as unknown as (opts: {
      tree: TreeInstance<FileEntry>;
      item: ItemInstance<FileEntry>;
      prev: () => Record<string, unknown>;
    }) => { onDragStart: (e: unknown) => void; draggable?: boolean };
    const props = getDragHandleProps({ tree, item, prev: () => ({ draggable: true, onDragStart: libDragStart }) });
    const d = dt();
    let isPrevented = false;
    props.onDragStart({
      dataTransfer: d,
      defaultPrevented: false,
      preventDefault: () => (isPrevented = true),
      isDefaultPrevented: () => isPrevented,
    });
    return { d, libDragStart, props };
  }

  it('按下的行在选中集里 → 写入整个选中集(含文件夹);库的 dragstart 照常执行', () => {
    const a = fakeItem(entry('/w/a.ts'));
    const src = fakeItem(entry('/w/src', true));
    const { d, libDragStart, props } = dragStart(a, [a, src]);
    expect(libDragStart).toHaveBeenCalledTimes(1);
    expect(props.draggable).toBe(true);
    expect(readExplorerDragData(d)?.entries).toEqual([
      { path: '/w/a.ts', isDirectory: false },
      { path: '/w/src', isDirectory: true },
    ]);
  });

  it('按下的行不在选中集里 → 只写它', () => {
    const a = fakeItem(entry('/w/a.ts'));
    const b = fakeItem(entry('/w/b.ts'));
    const { d } = dragStart(b, [a]);
    expect(readExplorerDragData(d)?.entries).toEqual([{ path: '/w/b.ts', isDirectory: false }]);
  });

  it('库拒绝拖动(preventDefault)→ 不写数据', () => {
    const a = fakeItem(entry('/w/a.ts'));
    const { d } = dragStart(a, [a], true);
    expect(d.types).toEqual([]);
  });

  it('树配置启用该 feature,且排在拖放 feature 之后(包住库的 dragstart)', () => {
    const features = createTreeConfig({ root: '/w', fs: { listDir: vi.fn() } }).features!;
    const keys = features.map((f) => f.key);
    expect(keys).toContain('explorer-drag-out');
    expect(keys.indexOf('explorer-drag-out')).toBeGreaterThan(keys.indexOf('drag-and-drop'));
  });
});
