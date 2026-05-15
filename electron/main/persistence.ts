import fs from 'node:fs/promises';
import { z } from 'zod';
import { atomicWriteJson } from './lib/atomic-write';
import { withExplorerFileMutex } from './lib/file-mutex';

// ─────────────────────────────────────────────────────
// DockviewReact 序列化输出。
// 顶层 version 锁死为 1,未来破坏性变更走 migration。passthrough 保留 dockview 自带字段。
// ─────────────────────────────────────────────────────

export const LayoutSchema = z
  .object({ version: z.literal(1).optional() })
  .passthrough();

// ─────────────────────────────────────────────────────
// explorer.json (资源管理器持久化:workspace/explorer/pinned)
// 详见 doc/08 § Zustand store 设计 + ADR-012 持久化范围。
// 与 LayoutSchema 不同:strict() 拒未知字段,因为 explorer 状态形态我们完全可控。
// 不持久化:explorer.selectedPaths / lastAnchorPath / search(瞬时态)。
//
// 多窗口 Phase 2(issue #23):schema 升级到 v2,把 workspace.root /
// explorer / layoutUi / editor 移到 `windows[]` 按 windowSeq 拆段;顶层
// 留全局共享 workspace.recentRoots / pinned。v1 自动迁移成 v2 一段
// (windowSeq=0)。loadExplorer 接受 v1 文件,saveExplorer 永远写 v2。
// ─────────────────────────────────────────────────────

const ExplorerSortSchema = z
  .object({
    by: z.enum(['name', 'mtime', 'ctime', 'size']),
    reverse: z.boolean(),
  })
  .strict();

const LayoutUiSchema = z
  .object({
    sidebarOpen: z.boolean(),
    sidebarWidth: z.number().int().positive(),
  })
  .strict();

const EditorSessionSchema = z
  .object({
    openFilePaths: z.array(z.string()),
    activePath: z.string().nullable(),
  })
  .strict();

// ── v1(legacy)— 仅 loadExplorer 接受,内部立即迁移到 v2 ────
const ExplorerV1Schema = z
  .object({
    version: z.literal(1),
    workspace: z
      .object({
        root: z.string().nullable(),
        recentRoots: z.array(z.string()),
      })
      .strict(),
    explorer: z
      .object({
        activePath: z.string().nullable(),
        expandedPaths: z.array(z.string()),
        sort: ExplorerSortSchema,
      })
      .strict(),
    pinned: z
      .object({
        paths: z.array(z.string()),
      })
      .strict(),
    layoutUi: LayoutUiSchema.optional(),
    editor: EditorSessionSchema.optional(),
  })
  .strict();

export type ExplorerV1Payload = z.infer<typeof ExplorerV1Schema>;

// ── v2(legacy compat)— 多窗口拆段 ────────────────────────
const WindowEntrySchema = z
  .object({
    windowSeq: z.number().int().nonnegative(),
    workspace: z
      .object({
        root: z.string().nullable(),
      })
      .strict(),
    explorer: z
      .object({
        activePath: z.string().nullable(),
        expandedPaths: z.array(z.string()),
        sort: ExplorerSortSchema,
      })
      .strict(),
    layoutUi: LayoutUiSchema.optional(),
    editor: EditorSessionSchema.optional(),
  })
  .strict();

/** @deprecated v2 compatibility schema. New callers should use ExplorerSchemaV3 / ExplorerWritableSnapshotSchema. */
export const ExplorerSchema = z
  .object({
    version: z.literal(2),
    workspace: z
      .object({
        recentRoots: z.array(z.string()),
      })
      .strict(),
    pinned: z
      .object({
        paths: z.array(z.string()),
      })
      .strict(),
    /** 下一个开新窗时分配的 windowSeq;主窗用 0,新窗自增. */
    nextWindowSeq: z.number().int().nonnegative(),
    /** 每窗口持久化段。windowSeq 跨重启稳定,关闭窗口段先保留(LRU 由调用方控制). */
    windows: z.array(WindowEntrySchema),
    /**
     * 启动时是否自动恢复非主窗 (windowSeq > 0)。
     * 默认 false — 跟 VSCode 默认 "只开主窗" 一致,避免持久化多 workspace
     * 用户每次启动看到一堆窗口弹出的惊吓。
     * 显式设 true 才走 #29 multi-window session-restore 行为。
     */
    restoreAllWindowsOnLaunch: z.boolean().optional(),
  })
  .strict();

export type ExplorerPayloadV2 = z.infer<typeof ExplorerSchema>;
export type ExplorerPayload = ExplorerPayloadV2 | ExplorerPayloadV3;
export type WindowEntry = z.infer<typeof WindowEntrySchema>;

// ─── v3 schema(本 topic 新加) ──────────────────────────

/** main-owned 字段集合:renderer 不能写,merge 时必须 preserve. */
export const MAIN_OWNED_WINDOW_FIELDS = ['layout', 'lastClosedAt'] as const;

/** Writable WindowEntry:strict,排除 main-owned 字段(layout/lastClosedAt). */
const ExplorerWritableWindowEntrySchema = z
  .object({
    windowSeq: z.number().int().nonnegative(),
    workspace: z.object({ root: z.string().nullable() }).strict(),
    explorer: z
      .object({
        activePath: z.string().nullable(),
        expandedPaths: z.array(z.string()),
        sort: ExplorerSortSchema,
      })
      .strict(),
    layoutUi: LayoutUiSchema.optional(),
    editor: EditorSessionSchema.optional(),
  })
  .strict();

/** Full WindowEntry v3:writable + main-owned. */
const WindowEntrySchemaV3 = ExplorerWritableWindowEntrySchema.extend({
  layout: LayoutSchema.optional(),
  lastClosedAt: z.number().int().nonnegative().nullable().optional(),
}).strict();

/** Writable Explorer Snapshot(renderer 用此 shape 写). */
export const ExplorerWritableSnapshotSchema = z
  .object({
    version: z.literal(3),
    workspace: z.object({ recentRoots: z.array(z.string()) }).strict(),
    pinned: z.object({ paths: z.array(z.string()) }).strict(),
    nextWindowSeq: z.number().int().nonnegative(),
    windows: z.array(ExplorerWritableWindowEntrySchema),
    restoreAllWindowsOnLaunch: z.boolean().optional(),
  })
  .strict();

/** Full Explorer Schema v3(loadExplorer 返回此 shape). */
export const ExplorerSchemaV3 = z
  .object({
    version: z.literal(3),
    workspace: z.object({ recentRoots: z.array(z.string()) }).strict(),
    pinned: z.object({ paths: z.array(z.string()) }).strict(),
    nextWindowSeq: z.number().int().nonnegative(),
    windows: z.array(WindowEntrySchemaV3),
    restoreAllWindowsOnLaunch: z.boolean().optional(),
  })
  .strict();

export type ExplorerWritablePayload = z.infer<
  typeof ExplorerWritableSnapshotSchema
>;
export type ExplorerWritableWindowEntry = z.infer<
  typeof ExplorerWritableWindowEntrySchema
>;
export type WindowEntryV3 = z.infer<typeof WindowEntrySchemaV3>;
export type ExplorerPayloadV3 = z.infer<typeof ExplorerSchemaV3>;

const DEFAULT_SORT = { by: 'name' as const, reverse: false };

export function defaultExplorerV3(): ExplorerPayloadV3 {
  return {
    version: 3,
    workspace: { recentRoots: [] },
    pinned: { paths: [] },
    nextWindowSeq: 1,
    windows: [
      {
        windowSeq: 0,
        workspace: { root: null },
        explorer: {
          activePath: null,
          expandedPaths: [],
          sort: DEFAULT_SORT,
        },
      },
    ],
  };
}

/**
 * v1 → v2 迁移:把原顶层 workspace.root / explorer / layoutUi / editor
 * 包成 windows[0](windowSeq=0,主窗位);workspace.recentRoots / pinned
 * 移到顶层全局段;nextWindowSeq=1。
 */
export function migrateV1ToV2(v1: ExplorerV1Payload): ExplorerPayloadV2 {
  const windowEntry: WindowEntry = {
    windowSeq: 0,
    workspace: { root: v1.workspace.root },
    explorer: v1.explorer,
    ...(v1.layoutUi ? { layoutUi: v1.layoutUi } : {}),
    ...(v1.editor ? { editor: v1.editor } : {}),
  };
  return {
    version: 2,
    workspace: { recentRoots: v1.workspace.recentRoots },
    pinned: v1.pinned,
    nextWindowSeq: 1,
    windows: [windowEntry],
  };
}

export function migrateV2ToV3(v2: ExplorerPayloadV2): ExplorerPayloadV3 {
  return {
    version: 3,
    workspace: v2.workspace,
    pinned: v2.pinned,
    nextWindowSeq: v2.nextWindowSeq,
    windows: v2.windows.map((w) => ({ ...w })),
    ...(v2.restoreAllWindowsOnLaunch !== undefined
      ? { restoreAllWindowsOnLaunch: v2.restoreAllWindowsOnLaunch }
      : {}),
  };
}

export function ensureWindowEntry(
  payload: ExplorerPayloadV3,
  seq: number,
): WindowEntryV3 {
  let entry = payload.windows.find((w) => w.windowSeq === seq);
  if (entry) return entry;
  entry = {
    windowSeq: seq,
    workspace: { root: null },
    explorer: {
      activePath: null,
      expandedPaths: [],
      sort: DEFAULT_SORT,
    },
  };
  payload.windows.push(entry);
  return entry;
}

export function pruneLRUClosed(
  payload: ExplorerPayloadV3,
  maxClosed: number,
  activeSeqs: ReadonlySet<number>,
): void {
  if (!Number.isFinite(maxClosed)) return;
  if (payload.windows.length <= maxClosed) return;

  const closed = payload.windows
    .filter((w) => !activeSeqs.has(w.windowSeq))
    .sort((a, b) => (a.lastClosedAt ?? 0) - (b.lastClosedAt ?? 0));

  const toRemove = payload.windows.length - maxClosed;
  if (toRemove <= 0) return;
  const removeSet = new Set<number>();
  for (let i = 0; i < Math.min(toRemove, closed.length); i++) {
    removeSet.add(closed[i]!.windowSeq);
  }
  payload.windows = payload.windows.filter(
    (w) => !removeSet.has(w.windowSeq),
  );
}

export function mergeWritableIntoFull(
  current: ExplorerPayloadV3 | null,
  writable: ExplorerWritablePayload,
): ExplorerPayloadV3 {
  const writableBySeq = new Map(
    writable.windows.map((w) => [w.windowSeq, w]),
  );

  const merged: WindowEntryV3[] = [];
  for (const cur of current?.windows ?? []) {
    const w = writableBySeq.get(cur.windowSeq);
    if (w) {
      merged.push({
        ...w,
        ...(cur.layout !== undefined ? { layout: cur.layout } : {}),
        ...(cur.lastClosedAt !== undefined
          ? { lastClosedAt: cur.lastClosedAt }
          : {}),
      });
      writableBySeq.delete(cur.windowSeq);
    } else {
      merged.push(cur);
    }
  }
  for (const w of writableBySeq.values()) {
    merged.push(w as WindowEntryV3);
  }

  return {
    ...writable,
    windows: merged,
  };
}

export async function loadExplorer(
  filePath: string,
): Promise<ExplorerPayloadV3 | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const v3 = ExplorerSchemaV3.safeParse(parsed);
    if (v3.success) return v3.data;
    const v2 = ExplorerSchema.safeParse(parsed);
    if (v2.success) return migrateV2ToV3(v2.data);
    const v1 = ExplorerV1Schema.safeParse(parsed);
    if (v1.success) return migrateV2ToV3(migrateV1ToV2(v1.data));
    return null;
  } catch {
    return null;
  }
}

export async function saveExplorer(
  filePath: string,
  payload: unknown,
): Promise<void> {
  const v3 = ExplorerSchemaV3.safeParse(payload);
  if (v3.success) {
    await atomicWriteJson(filePath, v3.data);
    return;
  }

  const v2 = ExplorerSchema.safeParse(payload);
  if (v2.success) {
    await atomicWriteJson(filePath, migrateV2ToV3(v2.data));
    return;
  }

  ExplorerSchemaV3.parse(payload);
}

export async function allocateWindowSeq(explorerFile: string): Promise<number> {
  return await withExplorerFileMutex(async () => {
    const payload = (await loadExplorer(explorerFile)) ?? defaultExplorerV3();
    const seq = payload.nextWindowSeq;
    payload.nextWindowSeq = seq + 1;
    await atomicWriteJson(explorerFile, payload);
    return seq;
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function migrateExplorerFileToV3(
  explorerFile: string,
  legacyLayoutFile: string,
): Promise<void> {
  const explorerExists = await fileExists(explorerFile);
  const legacyExists = await fileExists(legacyLayoutFile);

  if (!explorerExists && !legacyExists) return;

  if (!explorerExists && legacyExists) {
    await atomicWriteJson(explorerFile, defaultExplorerV3());
    await fs
      .unlink(legacyLayoutFile)
      .catch((err) => console.warn('[boot] legacy unlink failed', err));
    return;
  }

  const payload = await loadExplorer(explorerFile);
  if (payload == null) {
    console.warn('[boot] explorer.json corrupt; skipping migrate + legacy cleanup');
    return;
  }
  if (!legacyExists) {
    try {
      const raw = await fs.readFile(explorerFile, 'utf-8');
      if (ExplorerSchemaV3.safeParse(JSON.parse(raw)).success) return;
    } catch {
      // loadExplorer succeeded above, so this is best-effort no-op detection only.
    }
  }
  await atomicWriteJson(explorerFile, payload);
  if (legacyExists) {
    await fs
      .unlink(legacyLayoutFile)
      .catch((err) => console.warn('[boot] legacy unlink failed', err));
  }
}
