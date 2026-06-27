import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  dedupeWindowsBySeq,
  defaultExplorerV3,
  ensureWindowEntry,
  ExplorerSchemaV3,
  ExplorerWritableSnapshotSchema,
  loadExplorer,
  MAIN_OWNED_WINDOW_FIELDS,
  mergeWritableIntoFull,
  migrateV1ToV2,
  migrateV2ToV3,
  pruneLRUClosed,
  saveExplorer,
  type ExplorerPayload,
  type ExplorerPayloadV3,
  type ExplorerV1Payload,
  type ExplorerWritablePayload,
} from '../../../electron/main/persistence';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'continuo-explorer-v3-'));
  file = path.join(dir, 'explorer.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const sort = { by: 'name' as const, reverse: false };

const v2Payload: ExplorerPayload = {
  version: 2,
  workspace: { recentRoots: ['/work', '/old'] },
  pinned: { paths: ['/work/pinned.md'] },
  nextWindowSeq: 2,
  windows: [
    {
      windowSeq: 0,
      workspace: { root: '/work' },
      explorer: {
        activePath: '/work/file.md',
        expandedPaths: ['/work'],
        sort,
      },
      layoutUi: { sidebarOpen: false, sidebarWidth: 320 },
      editor: { openFilePaths: ['/work/file.md'], activePath: '/work/file.md' },
    },
    {
      windowSeq: 1,
      workspace: { root: '/other' },
      explorer: { activePath: null, expandedPaths: [], sort },
    },
  ],
  restoreAllWindowsOnLaunch: true,
};

const v1Payload: ExplorerV1Payload = {
  version: 1,
  workspace: { root: '/legacy', recentRoots: ['/legacy'] },
  explorer: {
    activePath: '/legacy/a.md',
    expandedPaths: ['/legacy'],
    sort,
  },
  pinned: { paths: ['/legacy/pinned.md'] },
  layoutUi: { sidebarOpen: true, sidebarWidth: 280 },
};

const writablePayload = (
  windows: ExplorerWritablePayload['windows'],
): ExplorerWritablePayload => ({
  version: 3,
  workspace: { recentRoots: ['/new'] },
  pinned: { paths: ['/new/pinned.md'] },
  nextWindowSeq: 4,
  windows,
});

describe('explorer.json v3 persistence schema and merge semantics', () => {
  it('T1: v3 schema accepts optional layout and lastClosedAt on window entries', () => {
    const payload = defaultExplorerV3();
    payload.windows[0] = {
      ...payload.windows[0]!,
      layout: { version: 1, grid: { root: 'dock' } },
      lastClosedAt: 123,
    };

    const parsed = ExplorerSchemaV3.parse(payload);

    expect(parsed.version).toBe(3);
    expect(parsed.windows[0]!.layout).toEqual({
      version: 1,
      grid: { root: 'dock' },
    });
    expect(parsed.windows[0]!.lastClosedAt).toBe(123);
  });

  it('T2: migrateV2ToV3 preserves v2 fields and leaves main-owned fields unset', () => {
    const migrated = migrateV2ToV3(v2Payload);

    expect(migrated).toMatchObject({
      version: 3,
      workspace: v2Payload.workspace,
      pinned: v2Payload.pinned,
      nextWindowSeq: v2Payload.nextWindowSeq,
      restoreAllWindowsOnLaunch: true,
    });
    expect(migrated.windows).toHaveLength(2);
    expect(migrated.windows[0]!.workspace.root).toBe('/work');
    expect(migrated.windows[0]!.layoutUi).toEqual(v2Payload.windows[0]!.layoutUi);
    expect(migrated.windows[0]!.editor).toEqual(v2Payload.windows[0]!.editor);
    expect(migrated.windows[0]!.layout).toBeUndefined();
    expect(migrated.windows[0]!.lastClosedAt).toBeUndefined();
  });

  it('migrateV2ToV3 预分配 windows 克隆数组,不调用 windows.map', () => {
    const mapSpy = vi.spyOn(v2Payload.windows, 'map');
    try {
      const migrated = migrateV2ToV3(v2Payload);
      expect(mapSpy).not.toHaveBeenCalled();
      expect(migrated.windows).toEqual(v2Payload.windows);
      expect(migrated.windows).not.toBe(v2Payload.windows);
      expect(migrated.windows[0]).not.toBe(v2Payload.windows[0]);
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('T3: v1 payload migrates to v3 through the v2 migration path', () => {
    const migrated = migrateV2ToV3(migrateV1ToV2(v1Payload));

    expect(migrated.version).toBe(3);
    expect(migrated.workspace.recentRoots).toEqual(['/legacy']);
    expect(migrated.pinned.paths).toEqual(['/legacy/pinned.md']);
    expect(migrated.nextWindowSeq).toBe(1);
    expect(migrated.windows[0]).toMatchObject({
      windowSeq: 0,
      workspace: { root: '/legacy' },
      explorer: v1Payload.explorer,
      layoutUi: v1Payload.layoutUi,
    });
  });

  it('T4: loadExplorer accepts v3 first, migrates v2 and v1, and returns null for unknown schema', async () => {
    const v3Payload = migrateV2ToV3(v2Payload);
    await fs.writeFile(file, JSON.stringify(v3Payload));
    expect(await loadExplorer(file)).toEqual(v3Payload);

    await fs.writeFile(file, JSON.stringify(v2Payload));
    expect(await loadExplorer(file)).toEqual(migrateV2ToV3(v2Payload));

    await fs.writeFile(file, JSON.stringify(v1Payload));
    expect(await loadExplorer(file)).toEqual(migrateV2ToV3(migrateV1ToV2(v1Payload)));

    await fs.writeFile(file, JSON.stringify({ version: 99, garbage: true }));
    expect(await loadExplorer(file)).toBeNull();
  });

  it('T5: saveExplorer writes validated v3 JSON', async () => {
    const payload = migrateV2ToV3(v2Payload);

    await saveExplorer(file, payload);

    const raw = JSON.parse(await fs.readFile(file, 'utf-8')) as ExplorerPayloadV3;
    expect(raw.version).toBe(3);
    expect(raw).toEqual(payload);
  });

  it('T6: pruneLRUClosed removes the oldest closed windows by lastClosedAt', () => {
    const payload = defaultExplorerV3();
    payload.windows = [
      { ...payload.windows[0]!, lastClosedAt: 500 },
      {
        windowSeq: 1,
        workspace: { root: '/one' },
        explorer: { activePath: null, expandedPaths: [], sort },
        lastClosedAt: 100,
      },
      {
        windowSeq: 2,
        workspace: { root: '/two' },
        explorer: { activePath: null, expandedPaths: [], sort },
        lastClosedAt: 300,
      },
      {
        windowSeq: 3,
        workspace: { root: '/three' },
        explorer: { activePath: null, expandedPaths: [], sort },
        lastClosedAt: 200,
      },
    ];

    pruneLRUClosed(payload, 2, new Set());

    expect(payload.windows.map((w) => w.windowSeq).sort()).toEqual([0, 2]);
  });

  it('T7: pruneLRUClosed never removes active window sequences', () => {
    const payload = defaultExplorerV3();
    payload.windows = [
      { ...payload.windows[0]!, lastClosedAt: 1 },
      {
        windowSeq: 1,
        workspace: { root: '/active-old' },
        explorer: { activePath: null, expandedPaths: [], sort },
        lastClosedAt: 2,
      },
      {
        windowSeq: 2,
        workspace: { root: '/closed-new' },
        explorer: { activePath: null, expandedPaths: [], sort },
        lastClosedAt: 3,
      },
    ];

    pruneLRUClosed(payload, 1, new Set([1]));

    expect(payload.windows.map((w) => w.windowSeq).sort()).toEqual([1]);
    pruneLRUClosed(payload, Infinity, new Set());
    expect(payload.windows.map((w) => w.windowSeq)).toEqual([1]);
  });

  it('ensureWindowEntry 按 windowSeq 查找走单趟 helper,不调用 windows.find', () => {
    const payload = defaultExplorerV3();
    payload.windows = [
      payload.windows[0]!,
      {
        windowSeq: 1,
        workspace: { root: '/one' },
        explorer: { activePath: null, expandedPaths: [], sort },
      },
    ];
    const findSpy = vi.spyOn(payload.windows, 'find');

    try {
      expect(ensureWindowEntry(payload, 1)).toBe(payload.windows[1]);
      expect(findSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  it('pruneLRUClosed 不对 payload.windows 调 filter 产生中间数组', () => {
    const payload = defaultExplorerV3();
    payload.windows = [
      { ...payload.windows[0]!, lastClosedAt: 500 },
      {
        windowSeq: 1,
        workspace: { root: '/one' },
        explorer: { activePath: null, expandedPaths: [], sort },
        lastClosedAt: 100,
      },
      {
        windowSeq: 2,
        workspace: { root: '/two' },
        explorer: { activePath: null, expandedPaths: [], sort },
        lastClosedAt: 300,
      },
    ];
    const filterSpy = vi.spyOn(payload.windows, 'filter');

    try {
      pruneLRUClosed(payload, 2, new Set());

      expect(filterSpy).not.toHaveBeenCalled();
      expect(payload.windows.map((w) => w.windowSeq).sort()).toEqual([0, 2]);
    } finally {
      filterSpy.mockRestore();
    }
  });

  it('dedupeWindowsBySeq 不对 payload.windows 调 filter 产生中间数组', () => {
    const payload = defaultExplorerV3();
    payload.windows = [
      { ...payload.windows[0]! },
      {
        windowSeq: 1,
        workspace: { root: '/first' },
        explorer: { activePath: null, expandedPaths: [], sort },
      },
      {
        windowSeq: 1,
        workspace: { root: '/duplicate' },
        explorer: { activePath: null, expandedPaths: [], sort },
      },
      {
        windowSeq: 2,
        workspace: { root: '/second' },
        explorer: { activePath: null, expandedPaths: [], sort },
      },
    ];
    const filterSpy = vi.spyOn(payload.windows, 'filter');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const next = dedupeWindowsBySeq(payload);

      expect(filterSpy).not.toHaveBeenCalled();
      expect(next.windows.map((w) => w.windowSeq)).toEqual([0, 1, 2]);
      expect(next.windows.find((w) => w.windowSeq === 1)?.workspace.root).toBe(
        '/first',
      );
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      filterSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('T22: writable snapshot schema rejects renderer attempts to write layout', () => {
    const writable = writablePayload([
      {
        windowSeq: 0,
        workspace: { root: '/work' },
        explorer: { activePath: null, expandedPaths: [], sort },
        layout: { version: 1 },
      } as unknown as ExplorerWritablePayload['windows'][number],
    ]);

    expect(() => ExplorerWritableSnapshotSchema.parse(writable)).toThrow();
  });

  it('T23: mergeWritableIntoFull preserves main-owned window fields', () => {
    const current = defaultExplorerV3();
    current.windows[0] = {
      ...current.windows[0]!,
      layout: { version: 1, from: 'main' },
      lastClosedAt: 456,
    };
    const writable = writablePayload([
      {
        windowSeq: 0,
        workspace: { root: '/renderer' },
        explorer: { activePath: '/renderer/a.md', expandedPaths: ['/renderer'], sort },
      },
    ]);

    const merged = mergeWritableIntoFull(current, writable);

    expect(MAIN_OWNED_WINDOW_FIELDS).toEqual(['layout', 'lastClosedAt']);
    expect(merged.windows[0]).toMatchObject({
      windowSeq: 0,
      workspace: { root: '/renderer' },
      layout: { version: 1, from: 'main' },
      lastClosedAt: 456,
    });
  });

  it('T24: ensureWindowEntry creates a minimal valid entry without replacing existing data', () => {
    const payload = defaultExplorerV3();
    payload.windows[0] = {
      ...payload.windows[0]!,
      workspace: { root: '/existing' },
      layout: { version: 1, keep: true },
    };

    const existing = ensureWindowEntry(payload, 0);
    const created = ensureWindowEntry(payload, 9);

    expect(existing.workspace.root).toBe('/existing');
    expect(existing.layout).toEqual({ version: 1, keep: true });
    expect(created).toEqual({
      windowSeq: 9,
      workspace: { root: null },
      explorer: { activePath: null, expandedPaths: [], sort },
    });
    expect(ExplorerSchemaV3.parse(payload).windows).toHaveLength(2);
  });
});
