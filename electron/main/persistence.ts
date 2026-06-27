import fs from 'node:fs/promises';
import { atomicWriteJson } from './lib/atomic-write';
import { withExplorerFileMutex } from './lib/file-mutex';
import { readFileCappedFd } from './lib/read-fh-capped';

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
  ExplorerWritableWindowEntry,
  WindowEntryV3,
  ExplorerPayloadV3,
} from '../shared/explorer-persistence-schema';

import {
  ExplorerSchema,
  ExplorerSchemaV3,
  ExplorerV1Schema,
} from '../shared/explorer-persistence-schema';
import type {
  ExplorerPayloadV2,
  ExplorerPayloadV3,
  ExplorerV1Payload,
  ExplorerWritablePayload,
  WindowEntry,
  WindowEntryV3,
} from '../shared/explorer-persistence-schema';

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

  const closed: WindowEntryV3[] = [];
  for (const w of payload.windows) {
    if (!activeSeqs.has(w.windowSeq)) closed.push(w);
  }
  closed.sort((a, b) => (a.lastClosedAt ?? 0) - (b.lastClosedAt ?? 0));

  const toRemove = payload.windows.length - maxClosed;
  if (toRemove <= 0) return;
  const removeSet = new Set<number>();
  for (let i = 0; i < Math.min(toRemove, closed.length); i++) {
    removeSet.add(closed[i]!.windowSeq);
  }
  const kept: WindowEntryV3[] = [];
  for (const w of payload.windows) {
    if (!removeSet.has(w.windowSeq)) kept.push(w);
  }
  payload.windows = kept;
}

export function mergeWritableIntoFull(
  current: ExplorerPayloadV3 | null,
  writable: ExplorerWritablePayload,
): ExplorerPayloadV3 {
  const writableBySeq = new Map<
    number,
    ExplorerWritablePayload['windows'][number]
  >();
  for (const w of writable.windows) writableBySeq.set(w.windowSeq, w);

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

/**
 * 文件存在但无法解析为任何已知 schema 时,把损坏内容保留成一次性 sidecar
 * `${filePath}.corrupt`。否则运行期写路径(`(await loadExplorer()) ?? defaultExplorerV3()`)
 * 会在下一次窗口关闭/布局写时把整个 explorer.json 静默覆盖成默认值 —— recentRoots /
 * pinned / 所有 window 段全部丢失且不可恢复。用 `flag:'wx'` 只保第一次损坏快照,
 * 不覆盖更早的备份,也不在每次损坏读时重复写。best-effort,失败不影响主流程。
 */
async function preserveCorruptExplorer(
  filePath: string,
  raw: string,
): Promise<void> {
  try {
    await fs.writeFile(`${filePath}.corrupt`, raw, { flag: 'wx' });
  } catch {
    // 备份已存在(EEXIST)或写失败 → best-effort,忽略
  }
}

// 边界(E67,E18/E26/E66 stat-before-read 族):explorer.json 是磁盘持久化文件,可能损坏或被
// 手工放大。此前 loadExplorer 直接整块 readFile + JSON.parse,大小/数组/字符串上限都在
// ExplorerSchemaV3.safeParse(解析之后)才生效 → 超大文件在启动/窗口恢复/布局读写前就
// OOM/CPU 峰值;损坏保留还会把完整 raw 二次写 .corrupt 放大 I/O。读前先 stat.size 硬拦,
// 超限不整块读入。explorer.json 即便多窗口 + dockview 布局也仅 KB~MB 级,16MiB 留足余量。
const MAX_EXPLORER_FILE_BYTES = 16 * 1024 * 1024;

/**
 * stat.size 预检的 capped 读取(单一来源,loadExplorer + migrate 二次读共用,避免漂移)。
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
  let r: Awaited<ReturnType<typeof readFileCappedFd>>;
  try {
    r = await readFileCappedFd(filePath, MAX_EXPLORER_FILE_BYTES);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (r.tooLarge) {
    throw new Error(
      `explorer file too large (${r.size} > ${MAX_EXPLORER_FILE_BYTES})`,
    );
  }
  return r.text;
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
  let dropped = 0;

  for (let i = 0; i < payload.windows.length; i++) {
    const w = payload.windows[i]!;
    if (seen.has(w.windowSeq)) {
      dropped++;
      if (deduped === null) {
        deduped = [];
        for (let j = 0; j < i; j++) deduped.push(payload.windows[j]!);
      }
      continue;
    }
    seen.add(w.windowSeq);
    if (deduped !== null) deduped.push(w);
  }

  if (deduped === null) return payload;
  console.warn(
    `[explorer] dropped ${dropped} window segment(s) with duplicate windowSeq`,
  );
  return { ...payload, windows: deduped };
}

export async function loadExplorer(
  filePath: string,
): Promise<ExplorerPayloadV3 | null> {
  // 只有「文件不存在」(ENOENT)才是首次启动语义 → null(调用方用默认值)。其它读错误
  // (EACCES/EIO/too-large 等)是「当前态未知」:绝不能当 null —— 否则调用方 `?? default` /
  // mergeWritableIntoFull(null,...) 后 atomicWriteJson 会用默认/局部快照覆盖一个**仍存在但
  // 暂不可读**的 explorer.json,丢 recentRoots/pinned/窗口段(codex 数据安全 P1)。readExplorerCapped
  // 在 ENOENT 返 null、其它(含 too-large)throw → 写路径在 file-mutex 回调内 reject、
  // atomicWriteJson 不执行 = 写中止;读路径经 safeHandle / 启动 try-catch 降级,均不覆盖磁盘。
  const raw = await readExplorerCapped(filePath);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    const v3 = ExplorerSchemaV3.safeParse(parsed);
    if (v3.success) return dedupeWindowsBySeq(v3.data);
    const v2 = ExplorerSchema.safeParse(parsed);
    if (v2.success) return dedupeWindowsBySeq(migrateV2ToV3(v2.data));
    const v1 = ExplorerV1Schema.safeParse(parsed);
    if (v1.success) {
      return dedupeWindowsBySeq(migrateV2ToV3(migrateV1ToV2(v1.data)));
    }
  } catch {
    // JSON.parse 抛错 → 落到下面的损坏保留
  }
  // 文件存在但既非合法 JSON 也不匹配任何已知 schema:保留快照后返回 null
  await preserveCorruptExplorer(filePath, raw);
  return null;
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
    let seq = payload.nextWindowSeq;
    // 边界(E4):nextWindowSeq 损坏为不安全整数(>= Number.MAX_SAFE_INTEGER)时 `seq + 1` 因浮点
    // 精度不变 → 计数器卡死,每个新窗口拿到同一 windowSeq → 多窗共享同一持久化段、互相覆盖
    // workspace/layout/editor 状态。schema 只校验 int().nonnegative(),不挡上界。此处自愈:不安全则
    // 重算为 max(现有段 windowSeq, 0) + 1(主窗占 0、新窗 ≥1 且大于所有现存安全段 → 不冲突),
    // 不丢任何持久化段(优于 schema .safe() 整文件失效丢全部段)。
    if (!Number.isSafeInteger(seq)) {
      const maxSeg = payload.windows.reduce(
        (m, w) =>
          Number.isSafeInteger(w.windowSeq) ? Math.max(m, w.windowSeq) : m,
        0,
      );
      seq = maxSeg + 1;
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
    // 丢 recentRoots/pinned/window 段,codex P1)。抛出由调用方决定 fail-safe。
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

export async function migrateExplorerFileToV3(
  explorerFile: string,
  legacyLayoutFile: string,
): Promise<void> {
  let explorerExists: boolean;
  let legacyExists: boolean;
  try {
    explorerExists = await fileExists(explorerFile);
    legacyExists = await fileExists(legacyLayoutFile);
  } catch (err) {
    // 数据安全:access 非 ENOENT 错误「无法确认存在性」→ 跳过迁移,绝不进入「写默认 +
    // 删 legacy」分支(否则把不可读但存在的 explorer.json 用默认覆盖、删旧 layout,丢
    // recentRoots/pinned/window 段,codex P1)。boot fail-safe:不写不删,下次启动重试。
    console.warn('[boot] explorer migrate skipped: cannot stat files', err);
    return;
  }

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
      // 边界(E67):二次读复用同一 capped loader(单一来源,不再裸 readFile)。
      const raw = await readExplorerCapped(explorerFile);
      if (raw !== null && ExplorerSchemaV3.safeParse(JSON.parse(raw)).success) {
        return;
      }
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
