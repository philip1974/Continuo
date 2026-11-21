import { describe, expect, it, vi } from 'vitest';

import {
  defaultExplorerV3,
  mergeWritableIntoFull,
  type ExplorerWritablePayload,
} from '../../../electron/main/persistence';

const sort = { by: 'name' as const, reverse: false };

const writablePayload: ExplorerWritablePayload = {
  version: 3,
  workspace: { recentRoots: ['/global'] },
  pinned: { paths: ['/global/pinned.md'] },
  nextWindowSeq: 3,
  windows: [
    {
      windowSeq: 1,
      workspace: { root: '/renderer-one' },
      explorer: {
        activePath: '/renderer-one/a.md',
        expandedPaths: ['/renderer-one'],
        sort,
      },
    },
    {
      windowSeq: 2,
      workspace: { root: '/renderer-two' },
      explorer: { activePath: null, expandedPaths: [], sort },
    },
  ],
};

describe('mergeWritableIntoFull current-window-only preservation', () => {
  it('T26: mergeWritableIntoFull updates writable fields for matching windows only', () => {
    const current = defaultExplorerV3();
    current.windows = [
      {
        windowSeq: 0,
        workspace: { root: '/current-only' },
        explorer: {
          activePath: '/current-only/a.md',
          expandedPaths: ['/current-only'],
          sort,
        },
        layout: { version: 1, keep: 'current-only' },
        lastClosedAt: 10,
      },
      {
        windowSeq: 1,
        workspace: { root: '/old-one' },
        explorer: {
          activePath: '/old-one/a.md',
          expandedPaths: ['/old-one'],
          sort,
        },
        layout: { version: 1, keep: 'main-owned' },
        lastClosedAt: 20,
      },
    ];

    const merged = mergeWritableIntoFull(current, writablePayload);

    expect(merged.workspace).toEqual(writablePayload.workspace);
    expect(merged.pinned).toEqual(writablePayload.pinned);
    expect(merged.nextWindowSeq).toBe(3);
    expect(merged.windows).toHaveLength(3);
    expect(merged.windows.find((w) => w.windowSeq === 0)).toEqual(current.windows[0]);
    expect(merged.windows.find((w) => w.windowSeq === 1)).toMatchObject({
      windowSeq: 1,
      workspace: { root: '/renderer-one' },
      explorer: {
        activePath: '/renderer-one/a.md',
        expandedPaths: ['/renderer-one'],
        sort,
      },
      layout: { version: 1, keep: 'main-owned' },
      lastClosedAt: 20,
    });
    expect(merged.windows.find((w) => w.windowSeq === 2)).toEqual(
      writablePayload.windows[1],
    );
  });

  it('mergeWritableIntoFull 不通过 writable.windows.map 构建 Map pairs 中间数组', () => {
    const current = defaultExplorerV3();
    const mapSpy = vi.spyOn(writablePayload.windows, 'map');

    try {
      const merged = mergeWritableIntoFull(current, writablePayload);

      expect(mapSpy).not.toHaveBeenCalled();
      expect(mergeWritableIntoFull.toString()).not.toContain('merged.push(');
      expect(merged.windows.find((w) => w.windowSeq === 1)).toMatchObject({
        workspace: { root: '/renderer-one' },
      });
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('mergeWritableIntoFull 单窗口 writable 快路径不构造 Map', () => {
    const current = defaultExplorerV3();
    current.windows = [
      {
        windowSeq: 1,
        workspace: { root: '/old-one' },
        explorer: { activePath: null, expandedPaths: [], sort },
        layout: { version: 1, keep: 'main-owned' },
        lastClosedAt: 20,
      },
    ];
    const writable: ExplorerWritablePayload = {
      ...writablePayload,
      windows: [writablePayload.windows[0]!],
    };
    const OriginalMap = globalThis.Map;
    let mapCtorCount = 0;
    class CountingMap<K, V> extends OriginalMap<K, V> {
      constructor(entries?: readonly (readonly [K, V])[] | null) {
        mapCtorCount += 1;
        super(entries);
      }
    }
    globalThis.Map = CountingMap as MapConstructor;

    try {
      const merged = mergeWritableIntoFull(current, writable);

      expect(mapCtorCount).toBe(0);
      expect(merged.windows).toHaveLength(1);
      expect(merged.windows[0]).toMatchObject({
        windowSeq: 1,
        workspace: { root: '/renderer-one' },
        layout: { version: 1, keep: 'main-owned' },
        lastClosedAt: 20,
      });
    } finally {
      globalThis.Map = OriginalMap;
    }
  });
});
