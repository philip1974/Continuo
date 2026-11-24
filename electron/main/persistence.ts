import fs from 'node:fs/promises';
import { atomicWriteJson } from './lib/atomic-write';
import { withExplorerFileMutex } from './lib/file-mutex';
import { readTextCappedOrThrow } from './lib/read-fh-capped';

// 可维护性 M15:Explorer 持久化 zod schema 抽到 electron/shared/explorer-persistence-schema.ts
// 单一来源(renderer 也复用),此处 re-export 保持对外 API 不变 + import 供内部读写/迁移使用。
export {
  LayoutSchema,
  ExplorerSchema,
  ExplorerWritableSnapshotSchema,
  ExplorerSchemaV3,
  MAIN_OWNED_WINDOW_FIELDS,
} from '../shared/explorer-persistence-schema';
export type {
  ExplorerV1Payload,
  ExplorerPayloadV2,
  ExplorerPayload,
  WindowEntry,
  ExplorerWritablePayload,
  WindowEntryV3,
  ExplorerPayloadV3,
} from '../shared/explorer-persistence-schema';

import {
  ExplorerSchema,
  ExplorerSchemaV3,
  ExplorerV1Schema,
  MAIN_OWNED_WINDOW_FIELDS,
} from '../shared/explorer-persistence-schema';
import { findWindowEntryBySeq } from '../shared/window-entry-lookup';
import type {
  ExplorerPayloadV2,
  ExplorerPayloadV3,
  ExplorerV1Payload,
  ExplorerWritablePayload,
  WindowEntry,
  WindowEntryV3,
} from '../shared/explorer-persistence-schema';
import { preserveCorruptSnapshot } from './lib/corrupt-snapshot';

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
  const windows = new Array<WindowEntryV3>(v2.windows.length);
  for (let i = 0; i < v2.windows.length; i++) {
    windows[i] = { ...v2.windows[i]! };
  }
  return {
    version: 3,
    workspace: v2.workspace,
    pinned: v2.pinned,
    nextWindowSeq: v2.nextWindowSeq,
    windows,
    ...(v2.restoreAllWindowsOnLaunch !== undefined
      ? { restoreAllWindowsOnLaunch: v2.restoreAllWindowsOnLaunch }
      : {}),
  };
}

export function ensureWindowEntry(
  payload: ExplorerPayloadV3,
  seq: number,
): WindowEntryV3 {
  let entry = findWindowEntryBySeq(payload.windows, seq);
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

/**
 * explorer.json windows[] 的段数上限(LRU:超出时摘最旧的 closed 段,活跃窗永不摘)。
 * 此前为 Infinity(topic-08 预留「先观察后裁剪」),真机已累积到 100+ 段,每次 layout/explorer 写都
 * 全量 parse+校验+stringify。取 64 = 启动恢复的候选检查预算 MAX_RESTORE_CHECKS:恢复最多看前 64 个
 * 候选段,更多的历史段本就不会被恢复。nextWindowSeq 是独立单调计数器,摘段不会让 seq 被复用。
 */
export const MAX_PERSISTED_WINDOW_SEGMENTS = 64;

/** 本进程启动时刻(模块加载时取一次)。 */
const PROCESS_BOOT_MS = Date.now();

/**
 * LRU 排序键:缺 lastClosedAt 视为「本进程启动时关闭」(PROCESS_BOOT_MS)。lastClosedAt 只在窗口 closed
 * 时写,而退出流程里那次写是 void 异步、app.quit 不等,崩溃更不写 → 缺时间戳的段多半是「上次会话仍开着」
 * 的窗口:按 0(最旧)排会在启动收敛 / 首次关窗时最先被摘;按 +Infinity(永远最新)排则跨启动永不老化,
 * 本次运行真正关闭、带时间戳的段反而先被摘。取启动时刻:比所有历史时间戳新(启动收敛保留它们),又比本次
 * 运行里关闭的段旧。缺时间戳的段之间按数组顺序稳定处理(Array.prototype.sort 稳定),段数始终有界。
 */
function lruClosedAt(w: WindowEntryV3): number {
  return w.lastClosedAt ?? PROCESS_BOOT_MS;
}

/**
 * 关窗写入的 lastClosedAt:不早于本进程启动时刻。启动后墙钟回拨(NTP 校正 / 虚拟机恢复)时,本次运行
 * 关闭的段不得排到缺时间戳段(按启动时刻排)之前被先摘。
 */
export function closedAtNow(): number {
  return Math.max(Date.now(), PROCESS_BOOT_MS);
}

/**
 * 给非保护且缺 lastClosedAt 的段补写 PROCESS_BOOT_MS 并随本次写盘落盘。缺失值若不落盘,每次启动都会被
 * 重算成当次启动时刻、永不老化:上一次运行里正常关闭(带时间戳)的段反而总先被摘。补写后排序键固定,
 * 从下次启动起按真实先后老化。保护段(活跃 / 关闭中 / seq 0)不写。
 */
export function stampMissingClosedAt(
  payload: ExplorerPayloadV3,
  protectedSeqs: ReadonlySet<number>,
): void {
  for (const w of payload.windows) {
    // schema 允许 null(与 lruClosedAt 的 ?? 一致视为缺失)。
    if (w.lastClosedAt == null && !protectedSeqs.has(w.windowSeq)) {
      w.lastClosedAt = PROCESS_BOOT_MS;
    }
  }
}

export function pruneLRUClosed(
  payload: ExplorerPayloadV3,
  maxClosed: number,
  activeSeqs: ReadonlySet<number>,
): void {
  if (!Number.isFinite(maxClosed)) return;
  if (payload.windows.length <= maxClosed) return;

  let closed: WindowEntryV3[] | null = null;
  let closedCount = 0;
  let closedSorted = true;
  let prevClosedAt = -Infinity;
  let scanned = 0;
  for (const w of payload.windows) {
    if (!activeSeqs.has(w.windowSeq)) {
      if (closed === null) {
        closed = new Array<WindowEntryV3>(payload.windows.length - scanned);
      }
      const closedAt = lruClosedAt(w);
      if (closedAt < prevClosedAt) closedSorted = false;
      prevClosedAt = closedAt;
      closed[closedCount++] = w;
    }
    scanned += 1;
  }
  if (closed === null) return;
  closed.length = closedCount;
  if (closedCount > 1 && !closedSorted) {
    // 缺时间戳的段键相同(PROCESS_BOOT_MS)→ 稳定排序保持数组顺序。
    closed.sort((a, b) => lruClosedAt(a) - lruClosedAt(b));
  }

  const toRemove = payload.windows.length - maxClosed; // > 0:函数开头已保证 length > maxClosed
  const removeSet = new Set<number>();
  for (let i = 0; i < Math.min(toRemove, closed.length); i++) {
    removeSet.add(closed[i]!.windowSeq);
  }
  const kept = new Array<WindowEntryV3>(payload.windows.length - removeSet.size);
  let keptCount = 0;
  for (const w of payload.windows) {
    if (!removeSet.has(w.windowSeq)) kept[keptCount++] = w;
  }
  kept.length = keptCount;
  payload.windows = kept;
}

/** renderer 写入的窗口段 + 保留 current 的 main-owned 字段(MAIN_OWNED_WINDOW_FIELDS;renderer 不能写)。 */
function withMainOwnedFields(
  w: ExplorerWritablePayload['windows'][number],
  cur: WindowEntryV3,
): WindowEntryV3 {
  const out: Record<string, unknown> = { ...w };
  for (const field of MAIN_OWNED_WINDOW_FIELDS) {
    if (cur[field] !== undefined) out[field] = cur[field];
  }
  return out as WindowEntryV3;
}

export function mergeWritableIntoFull(
  current: ExplorerPayloadV3 | null,
  writable: ExplorerWritablePayload,
): ExplorerPayloadV3 {
  const currentWindows = current?.windows ?? [];
  let merged: WindowEntryV3[];

  if (writable.windows.length === 1) {
    const w = writable.windows[0]!;
    merged = new Array<WindowEntryV3>(currentWindows.length + 1);
    let mergedCount = 0;
    let matched = false;
    for (const cur of currentWindows) {
      if (cur.windowSeq === w.windowSeq) {
        merged[mergedCount++] = withMainOwnedFields(w, cur);
        matched = true;
      } else {
        merged[mergedCount++] = cur;
      }
    }
    if (!matched) merged[mergedCount++] = w as WindowEntryV3;
    merged.length = mergedCount;
  } else {
    const writableBySeq = new Map<
      number,
      ExplorerWritablePayload['windows'][number]
    >();
    for (const w of writable.windows) writableBySeq.set(w.windowSeq, w);

    merged = new Array<WindowEntryV3>(
      currentWindows.length + writableBySeq.size,
    );
    let mergedCount = 0;
    for (const cur of currentWindows) {
      const w = writableBySeq.get(cur.windowSeq);
      if (w) {
        merged[mergedCount++] = withMainOwnedFields(w, cur);
        writableBySeq.delete(cur.windowSeq);
      } else {
        merged[mergedCount++] = cur;
      }
    }
    for (const w of writableBySeq.values()) {
      merged[mergedCount++] = w as WindowEntryV3;
    }
    merged.length = mergedCount;
  }

  // nextWindowSeq 是 main 独占的单调计数器(allocateWindowSeq 在 file-mutex 内
  // 自增)。renderer 的 writable 携带的是 hydrate 时读到的旧值,直接 ...writable
  // 会把 main 已递增的计数回退,导致后续新窗复用 seq → 两窗共享同一段互相覆盖。
  // 取 max 防回退:磁盘当前值与 renderer 值谁大用谁。
  // 边界(E138,E137 主进程写盘侧对偶):writable 来自 renderer IPC,schema 只校验 nonnegative int
  //(zod .int() **不拒 unsafe integer**)。直接 Math.max 信任 writable.nextWindowSeq 会把磁盘计数
  // 提升到 unsafe integer(allocateWindowSeq 自愈前已把坏计数写盘 + 污染 merge 契约)。只采纳
  // 安全非负整数;非法值忽略(回退 0,由 max 保留磁盘 current)。
  const safeSeq = (n: number | undefined): number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  const nextWindowSeq = Math.max(
    safeSeq(current?.nextWindowSeq),
    safeSeq(writable.nextWindowSeq),
  );

  // restoreAllWindowsOnLaunch 是 main 读取的顶层启动偏好(window-restore.service
  // 读它决定是否恢复所有窗口)。renderer 的 snapshotFromStores 从不携带它,因此裸
  // `...writable` 会在每次窗口 workspace 切换/tab 开关/树展开触发的 explorer:write
  // 时把它从盘上抹掉(同 nextWindowSeq 一样属 main-owned,renderer 不该覆盖)。
  // 取盘上 current 值优先、writable 兜底地显式保留。
  const restoreAllWindowsOnLaunch =
    current?.restoreAllWindowsOnLaunch ?? writable.restoreAllWindowsOnLaunch;

  return {
    ...writable,
    nextWindowSeq,
    windows: merged,
    ...(restoreAllWindowsOnLaunch !== undefined
      ? { restoreAllWindowsOnLaunch }
      : {}),
  };
}

// 边界(E67,E18/E26/E66 stat-before-read 族):explorer.json 是磁盘持久化文件,可能损坏或被
// 手工放大。此前 loadExplorer 直接整块 readFile + JSON.parse,大小/数组/字符串上限都在
// ExplorerSchemaV3.safeParse(解析之后)才生效 → 超大文件在启动/窗口恢复/布局读写前就
// OOM/CPU 峰值;损坏保留还会把完整 raw 二次写 .corrupt 放大 I/O。读前先 stat.size 硬拦,
// 超限不整块读入。explorer.json 即便多窗口 + dockview 布局也仅 KB~MB 级,16MiB 留足余量。
const MAX_EXPLORER_FILE_BYTES = 16 * 1024 * 1024;

/**
 * stat.size 预检的 capped 读取(单一来源,loadExplorer 唯一入口;迁移复用其 isV3 判定,不再二次读)。
 * - ENOENT(stat 或 TOCTOU 下 readFile)→ null(首次启动语义)
 * - size 超上限 → throw(同 EACCES「当前态未知」:绝不返 null 触发 `?? default` 覆盖,
 *   也不进 readFile/JSON.parse/preserveCorrupt 整块读)
 * - 其它读错误 → throw(当前态未知,绝不覆盖)
 */
async function readExplorerCapped(filePath: string): Promise<string | null> {
  // 边界(E160,E158/E159 兄弟 TOCTOU 修正):此前 `fs.stat(path).size` 预检 + `fs.readFile(path)` 两次
  // 独立路径解析,检查与读取之间 explorer.json 可被替换/增长绕过 16MiB 上限 → 整块读入 + JSON.parse,
  // 损坏路径还把超大 raw 写 .corrupt 放大 I/O。改用共享 readFileCappedFd(单 fd open→fstat 同 inode→
  // 有界读)。错误契约保持:ENOENT→null(首次启动);其它 open 错误(EACCES 等)→throw(当前态未知,
  // 绝不返 null 触发 `?? default` 覆盖);too-large→throw(同 EACCES,且不整块读入)。
  try {
    return await readTextCappedOrThrow(filePath, MAX_EXPLORER_FILE_BYTES, 'explorer file');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// 边界(E84,数据完整性):ExplorerSchemaV3 只限 windows 数量,不校验 windowSeq 唯一。畸形/手工编辑的
// explorer.json 可含多个相同 windowSeq 段并通过 safeParse;ensureWindowEntry/find 按 windowSeq 命中
// **首个**段,后续 layout/explorer 写都覆盖同一段,且启动恢复会为重复段各开一窗共享同一 seq →
// workspace/layout/editor 会话错乱或丢失。load 后 canonicalize:同一 windowSeq 只保留首段(与 find
// 的「命中首个」语义一致),丢弃重复段并告警。用 schema refine 会因一个重复段令整个 explorer.json
// 落入 corrupt → 默认值覆盖(丢 recentRoots/pinned/全部窗口),与 loadExplorer 的数据保留原则相悖,
// 故选 canonicalize 而非 fatal refine。
export function dedupeWindowsBySeq(payload: ExplorerPayloadV3): ExplorerPayloadV3 {
  const seen = new Set<number>();
  let deduped: WindowEntryV3[] | null = null;
  let dedupedCount = 0;
  let dropped = 0;

  for (let i = 0; i < payload.windows.length; i++) {
    const w = payload.windows[i]!;
    if (seen.has(w.windowSeq)) {
      dropped++;
      if (deduped === null) {
        deduped = new Array<WindowEntryV3>(payload.windows.length - 1);
        for (let j = 0; j < i; j++) {
          deduped[dedupedCount++] = payload.windows[j]!;
        }
      }
      continue;
    }
    seen.add(w.windowSeq);
    if (deduped !== null) deduped[dedupedCount++] = w;
  }

  if (deduped === null) return payload;
  deduped.length = dedupedCount;
  console.warn(
    `[explorer] dropped ${dropped} window segment(s) with duplicate windowSeq`,
  );
  return { ...payload, windows: deduped };
}

export async function loadExplorer(
  filePath: string,
): Promise<ExplorerPayloadV3 | null> {
  return (await loadExplorerWithFormat(filePath))?.payload ?? null;
}

/**
 * loadExplorer 的内部形态:额外报告磁盘原文是否**已是**合法 v3(`isV3`)。启动迁移据此判断是否需要
 * 回写,不必再读 + 解析 + 校验一次(性能:冷启动关键路径)。
 */
async function loadExplorerWithFormat(
  filePath: string,
): Promise<{ payload: ExplorerPayloadV3; isV3: boolean } | null> {
  // 只有「文件不存在」(ENOENT)才是首次启动语义 → null(调用方用默认值)。其它读错误
  // (EACCES/EIO/too-large 等)是「当前态未知」:绝不能当 null —— 否则调用方 `?? default` /
  // mergeWritableIntoFull(null,...) 后 atomicWriteJson 会用默认/局部快照覆盖一个**仍存在但
  // 暂不可读**的 explorer.json,丢 recentRoots/pinned/窗口段(数据安全 P1)。readExplorerCapped
  // 在 ENOENT 返 null、其它(含 too-large)throw → 写路径在 file-mutex 回调内 reject、
  // atomicWriteJson 不执行 = 写中止;读路径经 safeHandle / 启动 try-catch 降级,均不覆盖磁盘。
  const raw = await readExplorerCapped(filePath);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    const v3 = ExplorerSchemaV3.safeParse(parsed);
    if (v3.success) return { payload: dedupeWindowsBySeq(v3.data), isV3: true };
    const v2 = ExplorerSchema.safeParse(parsed);
    if (v2.success) {
      return { payload: dedupeWindowsBySeq(migrateV2ToV3(v2.data)), isV3: false };
    }
    const v1 = ExplorerV1Schema.safeParse(parsed);
    if (v1.success) {
      return {
        payload: dedupeWindowsBySeq(migrateV2ToV3(migrateV1ToV2(v1.data))),
        isV3: false,
      };
    }
  } catch {
    // JSON.parse 抛错 → 落到下面的损坏保留
  }
  // 文件存在但无法解析为任何已知 schema:留一次性 .corrupt 快照。否则运行期写路径
  //(`(await loadExplorer()) ?? defaultExplorerV3()`)会在下一次窗口关闭 / 布局写时把整个 explorer.json
  // 静默覆盖成默认值 —— recentRoots / pinned / 所有 window 段全部丢失且不可恢复。
  await preserveCorruptSnapshot(filePath, raw);
  return null;
}

/**
 * 段数收敛核心(调用方须持 explorer 文件锁):未超限 / 裁剪无变化 → 不写。
 * 运行期只在关窗时裁剪;启动时也跑一次(prepareExplorerFileForBoot),否则超长文件要等到第一次关窗才收敛。
 */
async function prunePayloadAndWrite(
  explorerFile: string,
  payload: ExplorerPayloadV3,
  activeSeqs: ReadonlySet<number>,
): Promise<void> {
  const before = payload.windows.length;
  pruneLRUClosed(payload, MAX_PERSISTED_WINDOW_SEGMENTS, activeSeqs);
  if (payload.windows.length === before) return;
  await atomicWriteJson(explorerFile, payload);
}

/**
 * 启动建窗前的 explorer.json 准备:v3 迁移 + 超长段数收敛,在**同一次**文件锁内共用**一次**加载。
 * 性能(冷启动关键路径):此前 migrate 读一次、判断是否已是 v3 再读一次、prune 又读一次 = 3 次
 * 读 + JSON.parse + Zod。语义与「先迁移到 v3、再做段数收敛」两步一致:
 * 迁移的数据安全分支(损坏 → .corrupt 快照且不覆盖 / 存在性未知 → 不写不删)原样保留,迁移读错误
 * 照旧抛出;收敛失败只告警不抛(原调用点 `.catch(warn)` 语义)。
 */
export async function prepareExplorerFileForBoot(
  explorerFile: string,
  legacyLayoutFile: string,
  activeSeqs: ReadonlySet<number>,
): Promise<void> {
  await withExplorerFileMutex(async () => {
    const migrated = await migrateExplorerFile(explorerFile, legacyLayoutFile);
    try {
      // MIGRATE_UNKNOWN(存在性无法确认)时迁移没读文件 → 收敛按原逻辑自己加载一次。
      const payload =
        migrated === MIGRATE_UNKNOWN ? await loadExplorer(explorerFile) : migrated;
      if (payload !== null) {
        await prunePayloadAndWrite(explorerFile, payload, activeSeqs);
      }
    } catch (err) {
      console.warn('[boot] explorer window segment prune skipped', err);
    }
  });
}

export async function allocateWindowSeq(explorerFile: string): Promise<number> {
  return await withExplorerFileMutex(async () => {
    const payload = (await loadExplorer(explorerFile)) ?? defaultExplorerV3();
    // 边界(E4):nextWindowSeq 损坏为不安全整数(>= Number.MAX_SAFE_INTEGER)时 `seq + 1` 因浮点
    // 精度不变 → 计数器卡死,每个新窗口拿到同一 windowSeq → 多窗共享同一持久化段、互相覆盖
    // workspace/layout/editor 状态。schema 只校验 int().nonnegative(),不挡上界。
    // 打磨 P2-BM(E4 兄弟):安全但 ≤ 现存最大 windowSeq 的计数(回退/手改)同样会分配重复 seq。
    // 统一自愈:seq = max(安全的 nextWindowSeq, 现存最大安全段 + 1, 1)(主窗占 0、新窗 ≥1 且
    // 大于所有现存安全段 → 不冲突),不丢任何持久化段(优于 schema .safe() 整文件失效丢全部段)。
    // 复审:现存段 = MAX_SAFE_INTEGER 时 maxSeg + 1 不安全(精度丢失)→ 每次分配同一值,重新卡死重复。
    // 候选值 + 1 须仍是安全整数(nextWindowSeq 也得安全);否则退化为最小未被占用的正整数。
    // 「占用」含已分配但段尚未落盘的 seq:计数仍安全时从它起找(< 它的都分配过),否则从 1 起。
    let maxSeg = 0;
    const used = new Set<number>();
    for (let i = 0; i < payload.windows.length; i += 1) {
      const windowSeq = payload.windows[i]!.windowSeq;
      if (!Number.isSafeInteger(windowSeq)) continue;
      used.add(windowSeq);
      if (windowSeq > maxSeg) maxSeg = windowSeq;
    }
    const next = payload.nextWindowSeq;
    let seq = Math.max(Number.isSafeInteger(next) ? next : 0, maxSeg + 1, 1);
    if (!Number.isSafeInteger(seq + 1)) {
      seq = Number.isSafeInteger(next + 1) && next >= 1 ? next : 1;
      // 复审:从计数起一路被占用到上界时 `seq += 1` 会越过 MAX_SAFE_INTEGER → 下一值(及写回的
      // nextWindowSeq = seq + 1)不安全时回绕到 1 继续找空位(used 有限,必有空位)。
      while (used.has(seq) || !Number.isSafeInteger(seq + 1)) {
        seq = Number.isSafeInteger(seq + 2) ? seq + 1 : 1;
      }
    }
    payload.nextWindowSeq = seq + 1;
    await atomicWriteJson(explorerFile, payload);
    return seq;
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch (err) {
    // 只有 ENOENT 才是「不存在」。EACCES/EIO/ELOOP 等「无法确认存在性」不能当不存在
    // (否则 migrate 把不可读但存在的 explorer.json 当缺失 → 写默认覆盖 + 删 legacy,
    // 丢 recentRoots/pinned/window 段,P1)。抛出由调用方决定 fail-safe。
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

const MIGRATE_UNKNOWN = Symbol('migrate-unknown');

/**
 * 迁移核心。返回迁移后磁盘上 explorer.json 对应的 payload(供启动收敛复用,免重读):
 * - null:文件不存在 / 损坏(收敛无事可做,与 loadExplorer 返回 null 同)
 * - MIGRATE_UNKNOWN:存在性无法确认、迁移跳过且未读文件
 */
async function migrateExplorerFile(
  explorerFile: string,
  legacyLayoutFile: string,
): Promise<ExplorerPayloadV3 | null | typeof MIGRATE_UNKNOWN> {
  let explorerExists: boolean;
  let legacyExists: boolean;
  try {
    explorerExists = await fileExists(explorerFile);
    legacyExists = await fileExists(legacyLayoutFile);
  } catch (err) {
    // 数据安全:access 非 ENOENT 错误「无法确认存在性」→ 跳过迁移,绝不进入「写默认 +
    // 删 legacy」分支(否则把不可读但存在的 explorer.json 用默认覆盖、删旧 layout,丢
    // recentRoots/pinned/window 段,P1)。boot fail-safe:不写不删,下次启动重试。
    console.warn('[boot] explorer migrate skipped: cannot stat files', err);
    return MIGRATE_UNKNOWN;
  }

  if (!explorerExists && !legacyExists) return null;

  if (!explorerExists && legacyExists) {
    const fresh = defaultExplorerV3();
    await atomicWriteJson(explorerFile, fresh);
    await fs
      .unlink(legacyLayoutFile)
      .catch((err) => console.warn('[boot] legacy unlink failed', err));
    return fresh;
  }

  const loaded = await loadExplorerWithFormat(explorerFile);
  if (loaded == null) {
    console.warn('[boot] explorer.json corrupt; skipping migrate + legacy cleanup');
    return null;
  }
  const { payload } = loaded;
  // 磁盘原文已是合法 v3 且无旧 layout → 无需回写(复用本次加载的判定,不再二次读 + 解析)。
  if (!legacyExists && loaded.isV3) return payload;
  await atomicWriteJson(explorerFile, payload);
  if (legacyExists) {
    await fs
      .unlink(legacyLayoutFile)
      .catch((err) => console.warn('[boot] legacy unlink failed', err));
  }
  return payload;
}
