// Terminal 多 session 全局 store(M-Terminal Step T3)。
// session 模型简洁,与 PTY id 一一对应;关闭后切活跃逻辑沿用 editor.store 同模式。
// 决策 #4:不持久化(重启 sessions 全部销毁),所以无 explorer-persist 介入。

import { create } from 'zustand';

export interface TerminalSession {
  /** 后端 PTY id (term-${uuid}). */
  readonly id: string;
  /** Tab 显示名(默认按序号:Terminal 1/2/...). */
  readonly title: string;
  /** ms epoch,用于 LRU 排序或调试. */
  readonly createdAt: number;
  /** null = PTY 仍在运行;number = 已 exit(显示 closed 标记). */
  exitCode: number | null;
}

export interface CloseResult {
  sessions: TerminalSession[];
  activeId: string | null;
}

/**
 * 关闭 session 后的新状态(纯函数,可单测):
 * - 关不存在的 id → 状态不变(返回原 sessions 引用)
 * - 关非活跃 → sessions 减,active 不变
 * - 关活跃且后面有 → 切下一个
 * - 关活跃且后面没 → 切前一个
 * - 关唯一 → activeId null
 */
export function nextActiveAfterClose(
  sessions: readonly TerminalSession[],
  activeId: string | null,
  closingId: string,
): CloseResult {
  const idx = sessions.findIndex((s) => s.id === closingId);
  if (idx === -1) {
    return { sessions: sessions as TerminalSession[], activeId };
  }
  const remaining = sessions.filter((s) => s.id !== closingId);
  if (remaining.length === 0) return { sessions: remaining, activeId: null };
  if (closingId !== activeId) return { sessions: remaining, activeId };
  const nextIdx = Math.min(idx, remaining.length - 1);
  return { sessions: remaining, activeId: remaining[nextIdx]?.id ?? null };
}

interface AddSessionArgs {
  id: string;
  title: string;
}

type TerminalState = {
  sessions: readonly TerminalSession[];
  activeId: string | null;

  addSession: (args: AddSessionArgs) => void;
  removeSession: (id: string) => void;
  switchSession: (id: string) => void;
  /** PTY exit 事件触发 → 标记 session 已退出(UI 显示 closed 标记). */
  setExited: (id: string, exitCode: number) => void;
  /** 主进程 cleanupAll 后或 workspace 切换时全清. */
  clearAll: () => void;
};

export const useTerminalStore = create<TerminalState>((set) => ({
  sessions: [],
  activeId: null,

  addSession: ({ id, title }) =>
    set((s) => ({
      sessions: [
        ...s.sessions,
        {
          id,
          title,
          createdAt: Date.now(),
          exitCode: null,
        },
      ],
      activeId: id,
    })),

  removeSession: (id) =>
    set((s) => nextActiveAfterClose(s.sessions, s.activeId, id)),

  switchSession: (id) => set(() => ({ activeId: id })),

  setExited: (id, exitCode) =>
    set((s) => {
      const idx = s.sessions.findIndex((sess) => sess.id === id);
      if (idx < 0) return s;
      const cur = s.sessions[idx]!;
      const next: TerminalSession = { ...cur, exitCode };
      const sessions = s.sessions.slice();
      sessions[idx] = next;
      return { sessions };
    }),

  clearAll: () => set(() => ({ sessions: [], activeId: null })),
}));
