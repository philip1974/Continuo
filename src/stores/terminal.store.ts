// Terminal sessions 镜像 store(M-Terminal Step T3 + Agent Terminal MCP P1)。
// 真相源在 main(electron/main/services/terminal-sessions.service.ts);本 store
// 接收 sessions_changed 推的 snapshot,只额外维护纯 UI 状态 activeId。
//
// 决策 #4(沿用):不持久化(重启 sessions 全部销毁)。
// BDD: src/__tests__/terminal-store/

import { create } from 'zustand';
import { pathEquals } from '@/lib/path-cross';
import type { ShellFamily } from '@continuo-terminal/shell-quote';
import type { TerminalSessionSnapshot } from '../../electron/shared/terminal-session';
import { LABEL_MAX, PATH_MAX } from '../../electron/shared/terminal-create';
// E203:SESSION_ID_MAX 收口到 shared/session-id-limits(此前本文件 / terminal.ipc.ts / MCP tools 各副本,防漂移)。
import { SESSION_ID_MAX } from '../../electron/shared/session-id-limits';
// E292:renderer IPC ingress 计数闸,复用 main 的全局会话上限单一来源。
import { MAX_TERMINAL_SESSIONS_GLOBAL } from '../../electron/shared/terminal-session-limits';

// 可维护性 M14:终端 session 形态复用 shared TerminalSessionSnapshot 单一来源
// (此前 main/preload/renderer 三层平行声明同组字段并已漂移)。
export type TerminalSession = TerminalSessionSnapshot;

export interface FilterDropOpts {
  onDrop?: (
    sessionId: string | undefined,
    reason:
      | 'not-object'
      | 'missing-owner'
      | 'wrong-owner'
      | 'shape-invalid'
      // 边界(E292):ingress 数组超 MAX_TERMINAL_SESSIONS_GLOBAL 时,超额项被丢弃。
      | 'over-capacity',
  ) => void;
}

/** attachTarget(optional)形态校验:undefined 或 3 个 discriminated 变体之一. */
function isAttachTargetShape(v: unknown): boolean {
  if (v === undefined) return true;
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  if (t.kind === 'active') return true;
  // 边界(E23):与 AttachTargetSchema 同步 —— panelId 限长、windowId 须非负安全整数,防畸形
  // attachTarget 经 sessions_changed 广播进各 renderer metadata 膨胀/匹配逻辑失真。
  if (t.kind === 'panel')
    return typeof t.panelId === 'string' && t.panelId.length <= 256;
  if (t.kind === 'window')
    return (
      typeof t.windowId === 'number' &&
      Number.isSafeInteger(t.windowId) &&
      t.windowId >= 0
    );
  return false;
}

/**
 * 可维护性 M16:IPC ingress 的完整 type guard —— 校验必填**与** optional 字段形态后
 * narrow 到 TerminalSession(= shared TerminalSessionSnapshot,M14),取代此前只校验必填
 * 字段、最后 `obj as unknown as TerminalSession` 双重断言(optional 字段绕过类型检查)。
 */
// 边界(E167,E23 同款 IPC-ingress 防御):session 经 sessions_changed/listSessions 广播进各
// renderer store。主进程写入口(create / updateCwd)已按 LABEL_MAX/PATH_MAX cap,本守卫是 renderer
// ingress 的纵深防御(对齐 E23 已给 attachTarget.panelId/windowId 加的长度/安全整数校验):字符串
// 字段镜像 create 的长度上限,数字字段须有限/安全整数,防畸形 payload 进 store 致 UI 卡顿/状态污染。
function isTerminalSessionShape(v: unknown): v is TerminalSession {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    obj.id.length <= SESSION_ID_MAX &&
    typeof obj.title === 'string' &&
    obj.title.length <= LABEL_MAX &&
    typeof obj.cwd === 'string' &&
    obj.cwd.length <= PATH_MAX &&
    (obj.originHint === 'user' || obj.originHint === 'agent') &&
    typeof obj.createdAt === 'number' &&
    Number.isFinite(obj.createdAt) &&
    (obj.exitCode === null ||
      (typeof obj.exitCode === 'number' && Number.isSafeInteger(obj.exitCode))) &&
    typeof obj.ownerWindowId === 'number' &&
    Number.isSafeInteger(obj.ownerWindowId) &&
    obj.ownerWindowId >= 0 &&
    (obj.agentLabel === undefined ||
      (typeof obj.agentLabel === 'string' && obj.agentLabel.length <= LABEL_MAX)) &&
    (obj.scoped === undefined || typeof obj.scoped === 'boolean') &&
    (obj.workspaceRoot === undefined ||
      (typeof obj.workspaceRoot === 'string' &&
        obj.workspaceRoot.length <= PATH_MAX)) &&
    isAttachTargetShape(obj.attachTarget)
  );
}

export function filterByOwnerWindow(
  sessions: readonly unknown[],
  currentWindowId: number,
  opts: FilterDropOpts = {},
): readonly TerminalSession[] {
  const result: TerminalSession[] = [];
  // 边界(E292,E167/E174 同款 IPC-ingress 纵深防御 / 数量维度):main 已按 MAX_TERMINAL_SESSIONS_GLOBAL
  // 双闸(E235)封顶真实会话数,但 renderer 此前对 sessions_changed / listSessions 推来的数组**长度**无
  // 上限 —— 有 bug / 被篡改的 main 推超大数组时,本 for 循环 O(n) 全量遍历 + 入 store + 渲染 n 个 tab,
  // 拖垮 renderer。超 MAX_TERMINAL_SESSIONS_GLOBAL 的超额项一律丢弃(只可能来自异常 main;正常全局 ≤256
  // 必在前 256 内,不丢任何合法会话)。
  let processed = 0;
  for (const s of sessions) {
    // 一次性发 over-capacity 信号并 break —— 不再遍历病态超大数组余项(全局合法 ≤256 必在前 256 内,
    // 故 break 不丢任何合法会话;只有异常 main 推超额项会触发)。
    if (processed >= MAX_TERMINAL_SESSIONS_GLOBAL) {
      opts.onDrop?.(undefined, 'over-capacity');
      break;
    }
    processed += 1;
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
  const visible: TerminalSession[] = [];
  for (const s of sessions) {
    if (
      s.workspaceRoot === undefined ||
      (currentRoot !== null && pathEquals(s.workspaceRoot, currentRoot))
    ) {
      visible.push(s);
    }
  }
  return visible;
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
  let found = false;
  let prev: TerminalSession | null = null;
  let next: TerminalSession | null = null;
  const remaining: TerminalSession[] = [];

  for (const session of sessions) {
    if (session.id === closingId) {
      found = true;
      continue;
    }
    if (found && next === null) next = session;
    remaining.push(session);
    if (!found) prev = session;
  }

  if (!found) {
    return { sessions, activeId };
  }
  if (remaining.length === 0) return { sessions: remaining, activeId: null };
  if (closingId !== activeId) return { sessions: remaining, activeId };
  return { sessions: remaining, activeId: next?.id ?? prev?.id ?? null };
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
  const newIds = new Set<string>();
  for (const s of newSessions) newIds.add(s.id);
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
      const newIds = new Set<string>();
      for (const x of newSessions) newIds.add(x.id);
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
      // 边界(E238):自定义标题按 LABEL_MAX(512,复用主进程 create/title 同款上限)截断。renameSession 是
      // renderer-only store 入口,不经主进程 terminal-create schema —— 极长标题否则进 customTitles 被
      // DockReconciler/Dock tab title 反复渲染,绕过主进程 512 边界致 UI 卡顿/内存膨胀。截断而非拒绝:
      // 保留用户重命名意图,只钳长度(空串仍走 delete 分支恢复默认标题)。
      const trimmed = title.trim().slice(0, LABEL_MAX);
      const next = new Map(s.customTitles);
      if (trimmed.length === 0) {
        next.delete(id);
      } else {
        next.set(id, trimmed);
      }
      return { customTitles: next };
    }),
}));
