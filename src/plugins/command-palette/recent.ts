// 命令面板"最近执行"列表(VSCode "Recently used" 同款)。
//
// localStorage 持久化:跨 session 保留,key=continuo:command-palette:recent。
// 上限 20 条,溢出从尾部丢弃。
//
// BDD: src/__tests__/command-palette-recent/

import { create } from 'zustand';
import { subscribeStorageKey } from '../storage/local-storage-record';

export const RECENT_STORAGE_KEY = 'continuo:command-palette:recent';
export const MAX_RECENT = 20;
// 边界(E72,E70/E71 解析前上限族):recent 列表读路径独立于 readRecord,JSON.parse 前无原始串
// 长度上限,E39 的 MAX_RECENT 只截断解析后结果,挡不住超大 raw 的解析成本。被篡改的 key 在启动 +
// 每次 record(读 live)+ storage 同步时反复 parse 卡顿。解析前按原始串长度拦,超限返 [] 并清毒。
// 列表仅 MAX_RECENT 条 × {id≤256, ts},正常仅数 KB,256KiB 留足余量。
const MAX_RECENT_RAW_LENGTH = 256 * 1024;
// 边界(E39,E5/E22 持久化读回族):command id 长度上限(与 CommandRegistry id 上限 E35 一致)。
const RECENT_ID_MAX = 256;
const EMPTY_RECENT_LIST: readonly RecentEntry[] = [];

export interface RecentEntry {
  readonly id: string;
  readonly ts: number;
}

interface RecentState {
  list: readonly RecentEntry[];
  record(id: string): void;
  clear(): void;
}

// 可维护性 M22:RecentEntry 运行时校验集中到 type guard,与静态类型绑定(给 RecentEntry
// 增字段时改一处即可),取代逐项 `(item as RecentEntry).id/.ts` + `push(item as RecentEntry)`。
// 边界(E39):type guard 不止校验类型,还限 id 长度 + 要求 ts 有限(NaN/Infinity 也是 number,
// 同 E5 时间戳教训)。畸形/篡改 localStorage 的超长 id、非有限 ts 在 CommandPalette 排序/比较/
// 渲染处放大开销,读回即过滤掉。
function isRecentEntry(value: unknown): value is RecentEntry {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    o.id.length <= RECENT_ID_MAX &&
    typeof o.ts === 'number' &&
    Number.isFinite(o.ts)
  );
}

// 导出供测试直接验读回守卫(E39)。
export function readFromStorage(): readonly RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return EMPTY_RECENT_LIST;
    // 边界(E72):解析前按原始串长度拦,防超大 raw 的 JSON.parse 卡顿(MAX_RECENT 只限解析后)。
    // 超限 = 篡改/旧残留 → 返 [] 并清毒(removeItem),避免每次 record/storage 同步反复解析。
    if (raw.length > MAX_RECENT_RAW_LENGTH) {
      try {
        localStorage.removeItem(RECENT_STORAGE_KEY);
      } catch {
        /* */
      }
      return EMPTY_RECENT_LIST;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return EMPTY_RECENT_LIST;
    // 边界(E39 / E209,E208 同族有界迭代):惰性循环按顺序收集合法项,凑满 MAX_RECENT 即 break ——
    // 不先 parsed.filter(isRecentEntry) 全量扫描+物化再 slice。篡改的 localStorage 可在 256KiB raw cap
    // 内塞大量短 entry,启动 / storage 同步 / 每次 record 读 live 列表都会完整遍历(MAX_RECENT=20 不早开)。
    // 列表最近优先(record 前插),头部即保留最近 MAX_RECENT 条。
    const out = new Array<RecentEntry>(MAX_RECENT);
    let count = 0;
    for (const item of parsed) {
      if (count >= MAX_RECENT) break;
      if (isRecentEntry(item)) out[count++] = item;
    }
    out.length = count;
    if (count === 0) return EMPTY_RECENT_LIST;
    return out;
  } catch {
    return EMPTY_RECENT_LIST;
  }
}

function writeToStorage(list: readonly RecentEntry[]): void {
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* QuotaExceededError / 隐私模式 → 静默,in-memory 仍可用 */
  }
}

export function buildNextRecentList(
  live: readonly RecentEntry[],
  id: string,
  ts: number,
): RecentEntry[] {
  const next = new Array<RecentEntry>(Math.min(MAX_RECENT, live.length + 1));
  let count = 0;
  next[count++] = { id, ts };
  for (const entry of live) {
    if (entry.id === id) continue;
    if (count >= MAX_RECENT) break;
    next[count++] = entry;
  }
  next.length = count;
  return next;
}

function recentListsEqual(
  a: readonly RecentEntry[],
  b: readonly RecentEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.id !== right.id || left.ts !== right.ts) return false;
  }
  return true;
}

export const useRecentCommandsStore = create<RecentState>((set, get) => ({
  // 启动期从 localStorage 读回
  list: readFromStorage(),

  record(id) {
    const now = Date.now();
    // race(R10,values-store/keybindings R6 同型):基于 live localStorage 合并,而非本窗 in-memory
    // get().list 整表写回 —— 多窗口几乎同时执行不同命令时,各自用旧列表整表写会让后写窗口覆盖
    // 先写窗口刚记录的命令(最近列表丢项/排序回退)。读 live 列表(含别窗刚记录的)再把本次置顶。
    const live = readFromStorage();
    const next = buildNextRecentList(live, id, now);
    if (recentListsEqual(get().list, next)) return;
    set({ list: next });
    writeToStorage(next);
  },

  clear() {
    set((s) =>
      s.list.length === 0 ? s : { list: EMPTY_RECENT_LIST },
    );
    try {
      localStorage.removeItem(RECENT_STORAGE_KEY);
    } catch {
      /* */
    }
  },
}));

// race(R10):跨窗口同步 —— 别窗 record/clear 写了 localStorage 时,本窗重读收敛列表
// (与 values-store 同款),避免本窗 in-memory 长期陈旧 + 下次 record 基于旧内存(已由
// live 读修;此处让 UI 即时反映别窗最近命令)。
subscribeStorageKey(RECENT_STORAGE_KEY, () =>
  useRecentCommandsStore.setState((s) => {
    const list = readFromStorage();
    return recentListsEqual(s.list, list) ? s : { list };
  }),
);
