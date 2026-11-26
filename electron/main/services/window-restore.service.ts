// 多窗口启动恢复(issue #23 Phase 2C;VSCode `window.restoreWindows` 同语义,默认恢复全部)。
//
// 启动时先同步开一个「首窗」(pickPrimaryWindowSeq),再从 explorer.json 的 windows[] 段挑出其余需要恢复的段,
// 逐个 createMainWindow({ windowSeq, workspace });全部建完后把焦点交给上次最后活动的窗口(lastActiveWindowSeq)。
//
// 恢复哪些窗口:
//   - 设置项「启动时恢复所有窗口」(explorer.json restoreAllWindowsOnLaunch;缺省 = true,同 VSCode 默认 `all`):
//     开 → 上次退出时开着的全部主窗口(openWindowSeqs,退出时写入;运行期用户关掉的窗口已移出,不再恢复);
//     关 → 只恢复一个:上次最后活动的那个窗口。
//   - openWindowSeqs 缺省(旧数据 / 从未正常退出过)→ 只开主窗 seq 0(不把历史上关掉的段一股脑弹出来)。
//
// 跳过规则(非首窗):
//   1. 首窗 seq — 已开,不重复
//   2. 不在 openWindowSeqs 里 — 上次退出前已关掉
//   3. workspace.root === null — 空段无恢复语义
//   4. workspace 路径不存在 / 不是目录 — 用户删了项目;段保留以防 mount
//      改回来,但启动时不开窗(async 判定,有界并发,不阻塞 main)

import type { ExplorerPayload } from '../persistence';
import { isWithinStartupPathLimit } from './cli-args.service';

export interface RestoreEntry {
  readonly windowSeq: number;
  readonly workspace: string;
}

const EMPTY_RESTORE_ENTRIES: RestoreEntry[] = [];

// 边界(E60,E58/E59 启动外部输入族):ExplorerSchemaV3 允许 windows 最多 10,000 段(数据保留用)。
// 但启动恢复会对每个非主窗段同步 isExistingDir(stat)+ index.ts
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
// 批大小与全局目录判定闸(lib/dir-stat-gate DIR_STAT_CONCURRENCY=2)对齐:更大的批也只会在闸前排队,
// 反而让取消后仍有更多已入队 stat 要跑完。
export const RESTORE_CHECK_CONCURRENCY = 2;

/** 设置项「启动时恢复所有窗口」:缺省(旧数据 / 从未改过)= 开(VSCode window.restoreWindows 默认 `all`)。 */
export function isRestoreAllWindowsEnabled(data: ExplorerPayload): boolean {
  return data.restoreAllWindowsOnLaunch !== false;
}

/** 上次退出时开着的主窗口 seq(最后一个 = 最后活动的):只留安全整数并去重(保序,重复取最后一次出现)。 */
export function openWindowSeqsAtLastExit(data: ExplorerPayload): number[] {
  const raw = data.openWindowSeqs;
  if (raw === undefined || raw.length === 0) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const seq = raw[i]!;
    if (!Number.isSafeInteger(seq) || seen.has(seq)) continue;
    seen.add(seq);
    out.push(seq);
  }
  return out.reverse();
}

/** 上次最后活动的主窗口 seq(重启后焦点给它);无记录 → null。 */
export function lastActiveWindowSeq(data: ExplorerPayload): number | null {
  const open = openWindowSeqsAtLastExit(data);
  return open.length === 0 ? null : open[open.length - 1]!;
}

/**
 * 启动时同步先开的窗口 seq。无记录 → 0(主窗);只恢复一个 → 最后活动的窗口;恢复全部 → 列表含 0 则 0,否则列表第一个。
 */
export function pickPrimaryWindowSeq(data: ExplorerPayload): number {
  const open = openWindowSeqsAtLastExit(data);
  if (open.length === 0) return 0;
  if (!isRestoreAllWindowsEnabled(data)) return open[open.length - 1]!;
  return open.includes(0) ? 0 : open[0]!;
}

/**
 * 退出时开着的主窗口按最近活动排序:`focusOrder`(末尾 = 最近聚焦)里出现过的按其顺序排在后面,没聚焦过的按原顺序排在前面。
 */
export function orderByRecentFocus(seqs: readonly number[], focusOrder: readonly number[]): number[] {
  const rank = new Map<number, number>();
  focusOrder.forEach((seq, i) => rank.set(seq, i));
  const unfocused = seqs.filter((s) => !rank.has(s));
  const focused = seqs.filter((s) => rank.has(s)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  return [...unfocused, ...focused];
}

/**
 * 用户关掉单个主窗口(非退出)后更新 openWindowSeqs(VSCode:关掉的窗口不再恢复)。还有别的主窗口开着 → 把它移出;
 * 它是最后一个主窗口 → 只留它(macOS 关光窗口后再退出 / Windows、Linux 关最后一个窗口即退出:下次恢复它)。
 * `remainingSeqs`:关窗当刻仍开着的其它主窗口。
 */
export function updateOpenWindowSeqsOnUserClose(
  payload: { openWindowSeqs?: number[] },
  seq: number,
  remainingSeqs: readonly number[],
): void {
  if (remainingSeqs.length === 0) {
    payload.openWindowSeqs = [seq];
    return;
  }
  if (payload.openWindowSeqs === undefined) return;
  payload.openWindowSeqs = payload.openWindowSeqs.filter((s) => s !== seq);
}

export async function pickWindowsToRestore(
  data: ExplorerPayload,
  isExistingDir: (path: string) => Promise<boolean> | boolean,
  isCancelled: () => boolean = () => false,
): Promise<RestoreEntry[]> {
  // 设置项关闭 → 只恢复一个(首窗);上次退出时没有记录 → 只开主窗。
  if (!isRestoreAllWindowsEnabled(data)) return EMPTY_RESTORE_ENTRIES;
  const open = openWindowSeqsAtLastExit(data);
  if (open.length === 0) return EMPTY_RESTORE_ENTRIES;
  const openSet = new Set(open);
  const primarySeq = pickPrimaryWindowSeq(data);
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
      if (entry.windowSeq === primarySeq) continue; // 首窗已开
      if (!openSet.has(entry.windowSeq)) continue; // 上次退出前已关掉 → 不恢复
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
    // 性能:每批返回后复核取消 —— 退出 / 全部关窗后不再发后续批次 stat(慢盘上在途 stat 占 libuv
    // 线程池,会拖慢退出时 explorer.json 落盘)。取消后上层不建任何窗,直接返回空即可。
    if (isCancelled()) return EMPTY_RESTORE_ENTRIES;
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
  restoreInFlight += 1;
  try {
    const data = await load();
    if (!data || isCancelled()) return;
    for (const entry of await pickWindowsToRestore(data, isExistingDir, isCancelled)) {
      if (isCancelled()) return;
      createWindow(entry);
    }
  } finally {
    restoreInFlight -= 1;
  }
}

let restoreInFlight = 0;

/**
 * 启动恢复阶段是否未结束(完成 / 失败 / 取消都算结束)。此阶段内即将被恢复的段尚不在 LRU 保护集,
 * 关窗写盘不得给它们补写缺失的 lastClosedAt(否则恢复后开着的窗口段带着本次启动时刻,下次启动反而偏旧)。
 */
export function isStartupRestoreInFlight(): boolean {
  return restoreInFlight > 0;
}
