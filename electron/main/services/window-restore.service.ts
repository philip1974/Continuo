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
//      改回来,但启动时不开窗(async 判定,有界并发,不阻塞 main)

import type { ExplorerPayload } from '../persistence';
import { isWithinStartupPathLimit } from './cli-args.service';

export interface RestoreEntry {
  readonly windowSeq: number;
  readonly workspace: string;
}

const EMPTY_RESTORE_ENTRIES: RestoreEntry[] = [];

// 边界(E60,E58/E59 启动外部输入族):ExplorerSchemaV3 允许 windows 最多 10,000 段(数据保留用)。
// 但启动恢复(restoreAllWindowsOnLaunch:true)会对每个非主窗段同步 isExistingDir(stat)+ index.ts
// 逐个 createMainWindow。畸形/手工编辑的 explorer.json 开 restore-all 即可在启动时做成千上万次同步
// stat + 批量开窗,阻塞主进程甚至拖垮桌面会话。启动恢复单独加现实上限(≠ 持久化 schema 的 10000):
// 最多恢复 MAX_RESTORE_WINDOWS 个非主窗,且超长 workspace 路径先跳过(不 stat)。
export const MAX_RESTORE_WINDOWS = 16;
// 边界(MAX_RESTORE_WINDOWS 只数「命中」):海量指向不存在目录的段永远凑不满命中数,仍会逐段同步
// stat。另设候选检查预算:每次 isExistingDir 都计数(无论命中与否),耗尽即停止。
export const MAX_RESTORE_CHECKS = 64;

// 性能(审计 #7):目录判定原为串行 statSync(最多 MAX_RESTORE_CHECKS 次),慢挂载 / 断开的网络盘会
// 阻塞 Electron main(首窗输入、IPC、建窗全停)。改为 async 判定 + 小规模有界并发:按 windows[] 顺序
// 取一批候选并发判定,再按原顺序回放串行规则(计数 / 去重 / 预算),集合、上限、顺序与串行一致。
export const RESTORE_CHECK_CONCURRENCY = 8;

export async function pickWindowsToRestore(
  data: ExplorerPayload,
  isExistingDir: (path: string) => Promise<boolean> | boolean,
): Promise<RestoreEntry[]> {
  // 默认只开主窗;显式 true 才恢复其他 window (session-restore opt-in)
  if (data.restoreAllWindowsOnLaunch !== true) return EMPTY_RESTORE_ENTRIES;
  let out: RestoreEntry[] | null = null;
  let count = 0;
  let checks = 0;
  // 边界(E84):防御性按 windowSeq 去重 —— 即便 explorer.json 含重复 windowSeq 段(load 端
  // canonicalize 已主防),也不为同一 seq 开多窗(多窗共享同段会互相覆盖会话)。
  let seenSeq: Set<number> | null = null;
  const windows = data.windows;
  let i = 0;
  while (i < windows.length) {
    if (count >= MAX_RESTORE_WINDOWS) break; // 边界(E60):启动开窗数上限,停止 + 停止 stat
    // 批大小不超过剩余检查预算与剩余开窗名额 → 判定次数与串行同界(全命中时不多 stat)。
    const limit = Math.min(
      RESTORE_CHECK_CONCURRENCY,
      MAX_RESTORE_CHECKS - checks,
      MAX_RESTORE_WINDOWS - count,
    );
    const batch: Array<{ windowSeq: number; ws: string }> = [];
    let batchSeqs: Set<number> | null = null;
    for (; i < windows.length && batch.length < limit; i += 1) {
      const entry = windows[i]!;
      if (entry.windowSeq === 0) continue;
      // 边界(E91):windowSeq 须安全整数。ExplorerSchemaV3 只校验 int().nonnegative(),畸形
      // explorer.json 的 9007199254740993(>MAX_SAFE_INTEGER)能过 schema;main 用它建窗注入
      // query,但 renderer parseInitialWindowSeq 判非法回退 0 → main/renderer 段编号认知不一致
      //(恢复窗按主窗段 hydrate / 后续写命不中自己段)。启动恢复跳过不安全 seq,不传 createMainWindow。
      if (!Number.isSafeInteger(entry.windowSeq)) continue;
      if (seenSeq?.has(entry.windowSeq)) continue; // 边界(E84):同 seq 只恢复一次
      const ws = entry.workspace.root;
      if (ws === null) continue;
      if (!isWithinStartupPathLimit(ws)) continue; // 边界(E60):超长路径先跳过,绝不 stat
      // 同批已有同 seq:其是否命中决定本段是否被去重跳过 → 留到下一批(保持串行语义)。
      if (batchSeqs?.has(entry.windowSeq)) break;
      if (batchSeqs === null) batchSeqs = new Set<number>();
      batchSeqs.add(entry.windowSeq);
      batch.push({ windowSeq: entry.windowSeq, ws });
    }
    // 候选检查预算耗尽(limit=0)或无更多候选:停止 stat
    if (batch.length === 0) break;
    checks += batch.length;
    const hits = await Promise.all(batch.map((c) => isExistingDir(c.ws)));
    for (let k = 0; k < batch.length; k += 1) {
      if (!hits[k]) continue;
      const c = batch[k]!;
      if (out === null) out = new Array<RestoreEntry>(MAX_RESTORE_WINDOWS);
      if (seenSeq === null) seenSeq = new Set<number>();
      seenSeq.add(c.windowSeq);
      out[count++] = { windowSeq: c.windowSeq, workspace: c.ws };
    }
  }
  if (out === null) return EMPTY_RESTORE_ENTRIES;
  out.length = count;
  return out;
}

/**
 * 启动恢复编排:读持久化 → 判定目录 → 逐段建窗,每个 await 之后与每次建窗之前复核 `isCancelled`。
 *
 * 目录判定改 async(审计 #7)后,慢 stat 期间事件循环可处理关窗 / 退出:若恢复完成后仍建窗,
 * macOS 关掉最后一个窗口后窗口会「复活」,退出时新窗还会落在 before-quit 已取的窗口快照之外,
 * 绕过 flush / 隐藏 / 资源清理。调用方在 before-quit / will-quit / window-all-closed 置取消。
 */
export async function restoreStartupWindows(
  load: () => Promise<ExplorerPayload | null>,
  isExistingDir: (path: string) => Promise<boolean> | boolean,
  createWindow: (entry: RestoreEntry) => void,
  isCancelled: () => boolean,
): Promise<void> {
  const data = await load();
  if (!data || isCancelled()) return;
  for (const entry of await pickWindowsToRestore(data, isExistingDir)) {
    if (isCancelled()) return;
    createWindow(entry);
  }
}
