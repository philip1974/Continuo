// 命令面板"最近执行"列表(VSCode "Recently used" 同款)。
//
// localStorage 持久化:跨 session 保留,key=continuo:command-palette:recent。
// 上限 20 条,溢出从尾部丢弃。
//
// BDD: src/__tests__/command-palette-recent/

import { create } from 'zustand';

export const RECENT_STORAGE_KEY = 'continuo:command-palette:recent';
export const MAX_RECENT = 20;

export interface RecentEntry {
  readonly id: string;
  readonly ts: number;
}

interface RecentState {
  list: readonly RecentEntry[];
  record(id: string): void;
  clear(): void;
}

function readFromStorage(): readonly RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // 防御:校验每项形态
    const valid: RecentEntry[] = [];
    for (const item of parsed) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as RecentEntry).id === 'string' &&
        typeof (item as RecentEntry).ts === 'number'
      ) {
        valid.push(item as RecentEntry);
      }
    }
    return valid;
  } catch {
    return [];
  }
}

function writeToStorage(list: readonly RecentEntry[]): void {
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* QuotaExceededError / 隐私模式 → 静默,in-memory 仍可用 */
  }
}

export const useRecentCommandsStore = create<RecentState>((set, get) => ({
  // 启动期从 localStorage 读回
  list: readFromStorage(),

  record(id) {
    const now = Date.now();
    const without = get().list.filter((e) => e.id !== id);
    const next: RecentEntry[] = [{ id, ts: now }, ...without].slice(
      0,
      MAX_RECENT,
    );
    set({ list: next });
    writeToStorage(next);
  },

  clear() {
    set({ list: [] });
    try {
      localStorage.removeItem(RECENT_STORAGE_KEY);
    } catch {
      /* */
    }
  },
}));
