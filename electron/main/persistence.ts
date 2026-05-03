import fs from 'node:fs/promises';
import { z } from 'zod';

// 顶层 version 锁死为 1,未来破坏性变更走 migration。passthrough 保留 dockview 自带字段。
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
