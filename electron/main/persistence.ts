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
// ─────────────────────────────────────────────────────

const ExplorerSortSchema = z
  .object({
    by: z.enum(['name', 'mtime', 'ctime', 'size']),
    reverse: z.boolean(),
  })
  .strict();

export const ExplorerSchema = z
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
    // sidebar 显隐 + 宽度;.optional() 向下兼容(旧 explorer.json 无此字段时
    // hydrate 走 store 默认值)。
    layoutUi: z
      .object({
        sidebarOpen: z.boolean(),
        sidebarWidth: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ExplorerPayload = z.infer<typeof ExplorerSchema>;

export async function loadExplorer(
  filePath: string,
): Promise<ExplorerPayload | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return ExplorerSchema.parse(JSON.parse(raw));
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
