// 多窗口启动恢复(issue #23 Phase 2C + 2026-05-14 opt-in 化)。
//
// Continuo 启动时主窗口固定先开 windowSeq=0;之后从 explorer.json 的 windows[]
// 段挑出需要恢复的非主窗段,逐个 createMainWindow({ windowSeq, workspace })。
//
// **opt-in 行为(2026-05-14 改默认)**:仅当 `restoreAllWindowsOnLaunch: true`
// 才走 multi-window restore;默认 / undefined 时只开主窗(VSCode 默认风格)。
// 之前默认 restore-all 让用户每次启动看到一堆持久化的 workspace 窗口弹出,
// UX 困惑。session-restore 设计保留为高级功能,user 可在 explorer.json 显
// 式开启或后续做 UI。
//
// 跳过规则(opt-in 后):
//   1. windowSeq === 0 — 主窗已开,不重复
//   2. workspace.root === null — 空段无恢复语义
//   3. workspace 路径不存在 / 不是目录 — 用户删了项目;段保留以防 mount
//      改回来,但启动时不开窗

import type { ExplorerPayload } from '../persistence';
import { isWithinStartupPathLimit } from './cli-args.service';

export interface RestoreEntry {
  readonly windowSeq: number;
  readonly workspace: string;
}

// 边界(E60,E58/E59 启动外部输入族):ExplorerSchemaV3 允许 windows 最多 10,000 段(数据保留用)。
// 但启动恢复(restoreAllWindowsOnLaunch:true)会对每个非主窗段同步 isExistingDir(stat)+ index.ts
// 逐个 createMainWindow。畸形/手工编辑的 explorer.json 开 restore-all 即可在启动时做成千上万次同步
// stat + 批量开窗,阻塞主进程甚至拖垮桌面会话。启动恢复单独加现实上限(≠ 持久化 schema 的 10000):
// 最多恢复 MAX_RESTORE_WINDOWS 个非主窗,且超长 workspace 路径先跳过(不 stat)。
export const MAX_RESTORE_WINDOWS = 16;

export function pickWindowsToRestore(
  data: ExplorerPayload,
  isExistingDir: (path: string) => boolean,
): RestoreEntry[] {
  // 默认只开主窗;显式 true 才恢复其他 window (session-restore opt-in)
  if (data.restoreAllWindowsOnLaunch !== true) return [];
  const out = new Array<RestoreEntry>(MAX_RESTORE_WINDOWS);
  let count = 0;
  // 边界(E84):防御性按 windowSeq 去重 —— 即便 explorer.json 含重复 windowSeq 段(load 端
  // canonicalize 已主防),也不为同一 seq 开多窗(多窗共享同段会互相覆盖会话)。
  const seenSeq = new Set<number>();
  for (const entry of data.windows) {
    if (count >= MAX_RESTORE_WINDOWS) break; // 边界(E60):启动开窗数上限,停止 + 停止同步 stat
    if (entry.windowSeq === 0) continue;
    // 边界(E91):windowSeq 须安全整数。ExplorerSchemaV3 只校验 int().nonnegative(),畸形
    // explorer.json 的 9007199254740993(>MAX_SAFE_INTEGER)能过 schema;main 用它建窗注入
    // query,但 renderer parseInitialWindowSeq 判非法回退 0 → main/renderer 段编号认知不一致
    //(恢复窗按主窗段 hydrate / 后续写命不中自己段)。启动恢复跳过不安全 seq,不传 createMainWindow。
    if (!Number.isSafeInteger(entry.windowSeq)) continue;
    if (seenSeq.has(entry.windowSeq)) continue; // 边界(E84):同 seq 只恢复一次
    const ws = entry.workspace.root;
    if (ws === null) continue;
    if (!isWithinStartupPathLimit(ws)) continue; // 边界(E60):超长路径先跳过,绝不 stat
    if (!isExistingDir(ws)) continue;
    seenSeq.add(entry.windowSeq);
    out[count++] = { windowSeq: entry.windowSeq, workspace: ws };
  }
  out.length = count;
  return out;
}
