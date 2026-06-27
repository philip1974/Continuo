// 打磨 R21(codex 性能 + 顺带修正确性):批量 paste/drop 到同一 destDir 时,
// 唯一名解析复用一次 listDir 快照(makeUniqueDestPicker),内部 makeNamePicker
// 每次 pick 把选中名加进 existing 集合 —— 不只省 N-1 次同目录 IPC,还防同批次
// 内多个同名项各自只见磁盘旧态、都选到同一个 ` copy` 名 → 第二个 move 覆盖第一
// 个(批量重名碰撞 = 潜在数据丢失)。
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSelectedPathSet,
  joinRelativePaths,
  makeNamePicker,
  selectDraggedItemPaths,
  selectRootDropMoveablePaths,
  selectVisibleTreeItems,
} from '../../panels/Explorer/FolderTree';

const ROOT = join(__dirname, '..', '..');

describe('打磨 R21 — makeNamePicker 唯一名解析', () => {
  it('目标不存在 → 用原 basename', () => {
    const pick = makeNamePicker('/d', new Set());
    expect(pick('a.md')).toBe('/d/a.md');
  });

  it('已存在 → 加 " copy" 后缀(保留扩展名)', () => {
    const pick = makeNamePicker('/d', new Set(['a.md']));
    expect(pick('a.md')).toBe('/d/a copy.md');
  });

  it('已存在 basename + copy → " copy 2"', () => {
    const pick = makeNamePicker('/d', new Set(['a.md', 'a copy.md']));
    expect(pick('a.md')).toBe('/d/a copy 2.md');
  });

  it('安全红线:同批次两个同名项 → 第二个自动 copy(防覆盖)', () => {
    const pick = makeNamePicker('/d', new Set());
    expect(pick('a.md')).toBe('/d/a.md'); // 第一个占用原名
    expect(pick('a.md')).toBe('/d/a copy.md'); // 第二个被预留集合挡开
    expect(pick('a.md')).toBe('/d/a copy 2.md'); // 第三个再退一位
  });

  it('无扩展名文件 → " copy" 加在末尾', () => {
    const pick = makeNamePicker('/d', new Set(['README']));
    expect(pick('README')).toBe('/d/README copy');
  });

  it('点开头隐藏文件(.env)→ 不当成扩展名', () => {
    const pick = makeNamePicker('/d', new Set(['.env']));
    // lastIndexOf('.')===0 → dot>0 为 false → 整体当 stem
    expect(pick('.env')).toBe('/d/.env copy');
  });
});

describe('打磨 — FolderTree 相对路径拼接', () => {
  it('复制相对路径时不通过 paths.map(...).join 生成中间数组', () => {
    const paths = ['/repo/src/a.ts', '/repo/docs/readme.md'];
    const mapSpy = vi.spyOn(Array.prototype, 'map');

    try {
      expect(joinRelativePaths('/repo', paths)).toBe('src/a.ts\ndocs/readme.md');
      expect(mapSpy.mock.contexts.some((ctx) => ctx === paths)).toBe(false);
    } finally {
      mapSpy.mockRestore();
    }
  });
});

describe('打磨 — FolderTree hidden file 过滤', () => {
  function item(name: string) {
    return {
      getItemData: () => ({ name }),
    } as never;
  }

  it('showHidden=false 时单趟保序选择非隐藏项,不调用 Array.prototype.filter', () => {
    const items = [item('a.ts'), item('.env'), item('b.ts')];
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      expect(selectVisibleTreeItems(items, false)).toEqual([
        items[0],
        items[2],
      ]);
      expect(filterSpy.mock.contexts.some((ctx) => ctx === items)).toBe(false);
    } finally {
      filterSpy.mockRestore();
    }
  });

  it('showHidden=true 时直接复用 allItems 引用', () => {
    const items = [item('a.ts'), item('.env')];
    expect(selectVisibleTreeItems(items, true)).toBe(items);
  });

  it('showHidden=false 且没有隐藏项时复用 allItems 引用', () => {
    const items = [item('a.ts'), item('b.ts')];
    expect(selectVisibleTreeItems(items, false)).toBe(items);
  });
});

describe('打磨 — FolderTree selectedPaths 构建', () => {
  it('空 selection 复用稳定空 Set', () => {
    const empty = buildSelectedPathSet(undefined);

    expect(empty).toEqual(new Set());
    expect(buildSelectedPathSet([])).toBe(empty);
    expect(buildSelectedPathSet(undefined)).toBe(empty);
  });

  it('非空 selection 构建 Set', () => {
    expect(buildSelectedPathSet(['/repo/a.ts', '/repo/b.ts'])).toEqual(
      new Set(['/repo/a.ts', '/repo/b.ts']),
    );
  });
});

describe('打磨 — FolderTree root-drop 可移动路径选择', () => {
  function dragged(path: string) {
    return {
      getId: () => path,
    } as never;
  }

  it('selectDraggedItemPaths 单趟取路径,不通过 Array.prototype.map', () => {
    const items = [dragged('/repo/a.ts'), dragged('/repo/b.ts')];
    const mapSpy = vi.spyOn(Array.prototype, 'map');

    try {
      expect(selectDraggedItemPaths(items)).toEqual(['/repo/a.ts', '/repo/b.ts']);
      expect(mapSpy.mock.contexts.some((ctx) => ctx === items)).toBe(false);
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('单趟从 draggedItems 取可移动路径,不先 map 再 filter', () => {
    const items = [
      dragged('/repo/a.ts'),
      dragged('/repo/child/b.ts'),
      dragged('/repo/other/c.ts'),
    ];
    const mapSpy = vi.spyOn(Array.prototype, 'map');
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      expect(selectRootDropMoveablePaths(items, '/repo')).toEqual([
        '/repo/child/b.ts',
        '/repo/other/c.ts',
      ]);
      expect(mapSpy.mock.contexts.some((ctx) => ctx === items)).toBe(false);
      expect(filterSpy.mock.contexts.some((ctx) => ctx === items)).toBe(false);
    } finally {
      mapSpy.mockRestore();
      filterSpy.mockRestore();
    }
  });

  it('root-drop 调用点直接用 selector,不先 draggedItems.slice() 复制快照', () => {
    const src = readFileSync(
      join(ROOT, 'panels', 'Explorer', 'FolderTree.tsx'),
      'utf8',
    );

    expect(src).not.toContain('draggedItems.slice()');
  });

  it('refresh 展开项 fallback 复用稳定空数组', () => {
    const src = readFileSync(
      join(ROOT, 'panels', 'Explorer', 'FolderTree.tsx'),
      'utf8',
    );

    expect(src).toContain('EMPTY_EXPANDED_ITEMS');
    expect(src).not.toContain('tree.getState().expandedItems ?? []');
    expect(src).not.toContain('[root, ...expanded]');
  });
});
