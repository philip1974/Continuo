// Terminal sessions 镜像 store(M-Terminal Step T3 + Agent Terminal MCP P1)。
// 真相源在 main(electron/main/services/terminal-sessions.service.ts);本 store
// 接收 sessions_changed 推的 snapshot,只额外维护纯 UI 状态 activeId。
//
// 决策 #4(沿用):不持久化(重启 sessions 全部销毁)。
// BDD: src/__tests__/terminal-store/

import { create } from 'zustand';

export interface TerminalSession {
  /** 后端 PTY id (term-${uuid}). */
  readonly id: string;
  /** Tab 显示名. */
  readonly title: string;
  /** PTY spawn 时的 cwd. */
  readonly cwd: string;
  /** session 来源:用户手开 / agent 通过 MCP 创建. */
  readonly originHint: 'user' | 'agent';
  /** agent 类型才填,如 'codex' / 'gemini'. */
  readonly agentLabel?: string;
  /** ms epoch. */
  readonly createdAt: number;
  /** null = PTY 仍在运行;number = 已 exit. */
  readonly exitCode: number | null;
}

export interface CloseResult {
  sessions: readonly TerminalSession[];
  activeId: string | null;
}

/**
 * 关闭 session 后的新状态(纯函数,可单测):
 * - 关不存在的 id → 状态不变(返回原 sessions 引用)
 * - 关非活跃 → sessions 减,active 不变
 * - 关活跃且后面有 → 切下一个
 * - 关活跃且后面没 → 切前一个
 * - 关唯一 → activeId null
 *
 * 仅 replaceSnapshot 内部使用,export 为保持纯函数测试面 + 给将来其它 close
 * 流程复用。
 */
export function nextActiveAfterClose(
  sessions: readonly TerminalSession[],
  activeId: string | null,
  closingId: string,
): CloseResult {
  const idx = sessions.findIndex((s) => s.id === closingId);
  if (idx === -1) {
    return { sessions, activeId };
  }
  const remaining = sessions.filter((s) => s.id !== closingId);
  if (remaining.length === 0) return { sessions: remaining, activeId: null };
  if (closingId !== activeId) return { sessions: remaining, activeId };
  const nextIdx = Math.min(idx, remaining.length - 1);
  return { sessions: remaining, activeId: remaining[nextIdx]?.id ?? null };
}

/**
 * 应用 main 推的 snapshot,保留 close 时的"切下一个"语义。
 * 算法:遍历 oldSessions,对不在 newSessions 中的 id 累计调用
 * nextActiveAfterClose;最后用 newSessions 覆盖 sessions 字段。
 */
export function applySnapshot(
  oldSessions: readonly TerminalSession[],
  oldActiveId: string | null,
  newSessions: readonly TerminalSession[],
): { sessions: readonly TerminalSession[]; activeId: string | null } {
  const newIds = new Set(newSessions.map((s) => s.id));
  let cur: readonly TerminalSession[] = oldSessions;
  let activeId = oldActiveId;
  for (const old of oldSessions) {
    if (!newIds.has(old.id)) {
      const r = nextActiveAfterClose(cur, activeId, old.id);
      cur = r.sessions;
      activeId = r.activeId;
    }
  }
  // 兜底:旧 active 仍非 null 但被神奇地不在新 snapshot,fallback 第一个
  if (activeId !== null && !newIds.has(activeId)) {
    activeId = newSessions[0]?.id ?? null;
  }
  // 空 → 非空:activeId 设为第一个
  if (activeId === null && newSessions.length > 0) {
    activeId = newSessions[0]!.id;
  }
  return { sessions: newSessions, activeId };
}

type TerminalState = {
  sessions: readonly TerminalSession[];
  activeId: string | null;

  /** 接收 main 推的 snapshot,保留 close 时的切换语义. */
  replaceSnapshot: (sessions: readonly TerminalSession[]) => void;
  /** UI 切换 active tab(不验证 id 是否存在,允许 create 后立即 setActive). */
  setActive: (id: string) => void;
};

export const useTerminalStore = create<TerminalState>((set) => ({
  sessions: [],
  activeId: null,

  replaceSnapshot: (newSessions) =>
    set((s) => applySnapshot(s.sessions, s.activeId, newSessions)),

  setActive: (id) => set(() => ({ activeId: id })),
}));
