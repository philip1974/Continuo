// Terminal sessions 镜像 store(M-Terminal Step T3 + Agent Terminal MCP P1)。
// 真相源在 main(electron/main/services/terminal-sessions.service.ts);本 store
// 接收 sessions_changed 推的 snapshot,只额外维护纯 UI 状态 activeId。
//
// 决策 #4(沿用):不持久化(重启 sessions 全部销毁)。
// BDD: src/__tests__/terminal-store/

import { create } from 'zustand';
import type { ShellFamily } from '@continuo-terminal/shell-quote';
import type { TerminalSessionSnapshot } from '../../electron/shared/terminal-session';

// 可维护性 M14:终端 session 形态复用 shared TerminalSessionSnapshot 单一来源
// (此前 main/preload/renderer 三层平行声明同组字段并已漂移)。
export type TerminalSession = TerminalSessionSnapshot;

export interface FilterDropOpts {
  onDrop?: (
    sessionId: string | undefined,
    reason: 'not-object' | 'missing-owner' | 'wrong-owner' | 'shape-invalid',
  ) => void;
}

/** attachTarget(optional)形态校验:undefined 或 3 个 discriminated 变体之一. */
function isAttachTargetShape(v: unknown): boolean {
  if (v === undefined) return true;
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  if (t.kind === 'active') return true;
  if (t.kind === 'panel') return typeof t.panelId === 'string';
  if (t.kind === 'window') return typeof t.windowId === 'number';
  return false;
}

/**
 * 可维护性 M16:IPC ingress 的完整 type guard —— 校验必填**与** optional 字段形态后
 * narrow 到 TerminalSession(= shared TerminalSessionSnapshot,M14),取代此前只校验必填
 * 字段、最后 `obj as unknown as TerminalSession` 双重断言(optional 字段绕过类型检查)。
 */
function isTerminalSessionShape(v: unknown): v is TerminalSession {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.title === 'string' &&
    typeof obj.cwd === 'string' &&
    (obj.originHint === 'user' || obj.originHint === 'agent') &&
    typeof obj.createdAt === 'number' &&
    (obj.exitCode === null || typeof obj.exitCode === 'number') &&
    typeof obj.ownerWindowId === 'number' &&
    (obj.agentLabel === undefined || typeof obj.agentLabel === 'string') &&
    (obj.scoped === undefined || typeof obj.scoped === 'boolean') &&
    (obj.workspaceRoot === undefined ||
      typeof obj.workspaceRoot === 'string') &&
    isAttachTargetShape(obj.attachTarget)
  );
}

export function filterByOwnerWindow(
  sessions: readonly unknown[],
  currentWindowId: number,
  opts: FilterDropOpts = {},
): readonly TerminalSession[] {
  const result: TerminalSession[] = [];
  for (const s of sessions) {
    if (!s || typeof s !== 'object') {
      opts.onDrop?.(undefined, 'not-object');
      continue;
    }
    const obj = s as Record<string, unknown>;
    const sessionId = typeof obj.id === 'string' ? obj.id : undefined;
    // owner 检查先行,保留 missing-owner / wrong-owner 的细分 drop reason。
    if (typeof obj.ownerWindowId !== 'number') {
      opts.onDrop?.(sessionId, 'missing-owner');
      continue;
    }
    if (obj.ownerWindowId !== currentWindowId) {
      opts.onDrop?.(sessionId, 'wrong-owner');
      continue;
    }
    if (!isTerminalSessionShape(obj)) {
      opts.onDrop?.(sessionId, 'shape-invalid');
      continue;
    }
    result.push(obj);
  }
  return result;
}

/**
 * 按当前 workspace 过滤可见 session。契约见 terminal-sessions.service.ts:52 + workspaceRoot
 * 字段注释:`visible = workspaceRoot === undefined(全局) || workspaceRoot === currentRoot`。
 * 同窗口切换 workspace 后,旧项目的 terminal(workspaceRoot=旧根)应从视图隐藏(PTY 不杀,
 * main 仍保留;切回旧根能重现);全局 session(agent 创建,workspaceRoot=undefined)始终可见。
 * currentRoot 为 null(未选 workspace)时只剩全局 session。(codex 复审 loop R12)
 */
export function filterByWorkspaceRoot(
  sessions: readonly TerminalSession[],
  currentRoot: string | null,
): readonly TerminalSession[] {
  return sessions.filter(
    (s) => s.workspaceRoot === undefined || s.workspaceRoot === currentRoot,
  );
}

export function getShellFamily(sessionId: string): ShellFamily {
  const session = useTerminalStore
    .getState()
    .sessions.find((s) => s.id === sessionId);
  const shellFamily = (session as (TerminalSession & { shellFamily?: ShellFamily }) | undefined)
    ?.shellFamily;
  if (shellFamily) return shellFamily;

  console.warn(
    `[terminal-drag-drop] shellFamily missing for ${sessionId}; falling back to platform default`,
  );
  // renderer-safe: `process` is Node-only and undefined in Electron renderer;
  // navigator.platform is filled by Electron + browser convention (mirrors
  // format-hotkey.ts pattern). issue #40 R2 hot-fix.
  const platform =
    typeof navigator !== 'undefined' && typeof navigator.platform === 'string'
      ? navigator.platform
      : '';
  return platform.startsWith('Win') ? 'powershell' : 'posix';
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
): { sessions: readonly TerminalSession[]; activeId: string | null } {
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
  /**
   * UI 端 title override(issue #19)。Map<sessionId, customTitle>。
   * 不破坏 main 真相源(TerminalSession.title 保持来自 main),只在显示层覆盖。
   * 不持久化(沿用 Continuo 决策 #4 — sessions 重启全销毁,override 跟着无)。
   * snapshot 移除某 id 时,这里也清理避免泄漏。
   */
  customTitles: ReadonlyMap<string, string>;

  /** 接收 main 推的 snapshot,保留 close 时的切换语义. */
  replaceSnapshot: (sessions: readonly TerminalSession[]) => void;
  /** UI 切换 active tab(不验证 id 是否存在,允许 create 后立即 setActive). */
  setActive: (id: string) => void;
  /**
   * UI 双击 tab 后改名。空字符串 / 仅空白 → 删除该 id 的 override
   * (回退到 main 给的 title)。
   */
  renameSession: (id: string, title: string) => void;
};

export const useTerminalStore = create<TerminalState>((set) => ({
  sessions: [],
  activeId: null,
  customTitles: new Map(),

  replaceSnapshot: (newSessions) =>
    set((s) => {
      const applied = applySnapshot(s.sessions, s.activeId, newSessions);
      // 清理 customTitles 中已不在新 snapshot 的 id
      const newIds = new Set(newSessions.map((x) => x.id));
      let titles = s.customTitles;
      let changed = false;
      for (const id of titles.keys()) {
        if (!newIds.has(id)) {
          if (!changed) {
            titles = new Map(titles);
            changed = true;
          }
          (titles as Map<string, string>).delete(id);
        }
      }
      return { ...applied, customTitles: titles };
    }),

  setActive: (id) => set(() => ({ activeId: id })),

  renameSession: (id, title) =>
    set((s) => {
      const trimmed = title.trim();
      const next = new Map(s.customTitles);
      if (trimmed.length === 0) {
        next.delete(id);
      } else {
        next.set(id, trimmed);
      }
      return { customTitles: next };
    }),
}));
