// 可维护性 M15:Explorer 持久化(explorer.json)的 zod schema 单一来源。
//
// 此前这些 schema 写在 electron/main/persistence.ts(含 node:fs 依赖,renderer 无法
// import),renderer 端只好在 explorer-persist.ts 另手写一套 `isExplorerSnapshot` 谓词,
// 且已漂移变松(只校验数组外壳,不校验元素类型 / int / strict)。把纯 zod schema 抽到本
// shared 模块(无 node 依赖):main 的 persistence.ts re-export 并继续使用;renderer 用
// safeParse 复用,磁盘契约变成单一来源。
//
// 详见 doc/08 § Zustand store 设计 + ADR-012 持久化范围。explorer 状态形态完全可控,故
// strict() 拒未知字段。多窗口 Phase 2(issue #23)升级到 v2/v3:workspace.root / explorer /
// layoutUi / editor 移到 windows[] 按 windowSeq 拆段;v1 自动迁移。

import { z } from 'zod';

// ─────────────────────────────────────────────────────
// DockviewReact 序列化输出。顶层 version 锁 1,passthrough 保留 dockview 自带字段。
// ─────────────────────────────────────────────────────
export const LayoutSchema = z
  .object({ version: z.literal(1).optional() })
  .passthrough();

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
export const ExplorerV1Schema = z
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
     * 启动时是否自动恢复非主窗 (windowSeq > 0)。默认 false — 跟 VSCode "只开主窗" 一致。
     * 显式设 true 才走 #29 multi-window session-restore 行为。
     */
    restoreAllWindowsOnLaunch: z.boolean().optional(),
  })
  .strict();

export type ExplorerPayloadV2 = z.infer<typeof ExplorerSchema>;
export type ExplorerPayload = ExplorerPayloadV2 | ExplorerPayloadV3;
export type WindowEntry = z.infer<typeof WindowEntrySchema>;

// ─── v3 schema ──────────────────────────────────────────

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
