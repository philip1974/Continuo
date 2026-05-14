import fs from 'node:fs/promises';
import { z } from 'zod';

// ─────────────────────────────────────────────────────
// layout.json (DockviewReact 序列化输出)
// 顶层 version 锁死为 1,未来破坏性变更走 migration。passthrough 保留 dockview 自带字段。
// ─────────────────────────────────────────────────────

export const LayoutSchema = z
  .object({ version: z.literal(1).optional() })
  .passthrough();

export type LayoutPayload = z.infer<typeof LayoutSchema>;

export async function loadLayout(filePath: string): Promise<LayoutPayload | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return LayoutSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveLayout(filePath: string, json: unknown): Promise<boolean> {
  const safe = LayoutSchema.parse(json);
  await fs.writeFile(filePath, JSON.stringify(safe, null, 2));
  return true;
}

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

// ── v2(current)— 多窗口拆段 ──────────────────────────────
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

export type ExplorerPayload = z.infer<typeof ExplorerSchema>;
export type WindowEntry = z.infer<typeof WindowEntrySchema>;

/**
 * v1 → v2 迁移:把原顶层 workspace.root / explorer / layoutUi / editor
 * 包成 windows[0](windowSeq=0,主窗位);workspace.recentRoots / pinned
 * 移到顶层全局段;nextWindowSeq=1。
 */
export function migrateV1ToV2(v1: ExplorerV1Payload): ExplorerPayload {
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

export async function loadExplorer(
  filePath: string,
): Promise<ExplorerPayload | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    // 先试 v2,不行回退 v1 + 迁移。损坏 / 未知 schema → null
    const v2 = ExplorerSchema.safeParse(parsed);
    if (v2.success) return v2.data;
    const v1 = ExplorerV1Schema.safeParse(parsed);
    if (v1.success) return migrateV1ToV2(v1.data);
    return null;
  } catch {
    return null;
  }
}

export async function saveExplorer(
  filePath: string,
  json: unknown,
): Promise<void> {
  const safe = ExplorerSchema.parse(json);
  await fs.writeFile(filePath, JSON.stringify(safe, null, 2));
}
