// Terminal session metadata 真相源(main 进程,Phase 1 搬迁后启用)。
// PTY 进程仍由 terminal.service.ts 持;本 service 持 metadata + emitter,
// 通过 IPC sessions_changed 推送给 renderer。
//
// ── Lifecycle state machine (ADR 0003 C2 promote from red-team-v1 P1-2) ─────
//
// 每个 session 经历三态:
//
//   live  ──setExited(id, exitCode)──▶  exited-retained  ──remove(id) /───▶  removed
//                                                          removeByOwner /
//                                                          (window close)
//
// - live:exitCode === null;PTY 仍在运行;handleExit 未触发
// - exited-retained:exitCode !== null;PTY 已终止 (SessionManager.removeSession 已 dispose),
//   但 Continuo overlay entry 仍在 Map (用于 UI 显示 "(exited code N)" badge);user 可
//   通过 right-click close 触发 remove
// - removed:entry 已 sessions.delete;subscribers 收到 snapshot 不再含该 id
//
// 触发方:
// - setExited:由 SessionManagerOptions.onExit callback (Step 0.6 commit 96275e4) →
//   handleExit → cleanupSessionLocal → setExited;exitCode 来自 PTY exit 真实值
// - remove:IPC TERMINAL_REMOVE handler (user 主动关 panel) / agent-auth cleanup
// - removeByOwner:BrowserWindow 'closed' 事件 → cleanupAllForWindow → removeByOwner;
//   exited-retained 与 live 都被 cascade 删除
//
// 该状态机隐式实现自 Step 1 (commit dffc5e0),本 JSDoc 显式 promote 自 ADR 0003。
//
// BDD: src/__tests__/terminal-sessions-service/

import { ERROR_CODES } from '../../shared/error-codes';
import {
  MAX_TERMINAL_SESSIONS_GLOBAL,
  MAX_TERMINAL_SESSIONS_PER_WINDOW,
} from '../../shared/terminal-session-limits';
import type { OriginHint } from '../../shared/origin-hint';
import type { AttachTarget } from '../../shared/terminal-attach';
import type { TerminalSessionSnapshot } from '../../shared/terminal-session';
import type { ShellFamily } from '@continuo-terminal/shell-quote';

export type { AttachTarget } from '../../shared/terminal-attach';

// 可维护性 M14:renderer-visible 字段复用 shared TerminalSessionSnapshot 单一来源;
// 此处只追加 main-内部字段(controllerToken,绝不跨 IPC 给 renderer)。
export interface MainTerminalSession extends TerminalSessionSnapshot {
  /**
   * 安全 S3(codex 安全审计):创建该会话的 MCP 调用方身份(HTTP=bearer token,
   * stdio=每连接 subject)。读/写/杀类 MCP 工具只允许「在本窗口且该会话由调用方
   * 创建」(controllerToken === ctx.callerSubject)。user 终端(Cmd+T,IPC 创建)
   * 无 controllerToken → 任何 MCP 调用方都无权读控。随会话生命周期自动清理。
   */
  readonly controllerToken?: string;
}

export interface AddSessionInput {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly originHint: OriginHint;
  readonly agentLabel?: string;
  readonly scoped?: boolean;
  readonly ownerWindowId: number;
  readonly attachTarget?: AttachTarget;
  readonly workspaceRoot?: string;
  /** 跨平台:PTY shell 引号族(见 TerminalSessionSnapshot.shellFamily). */
  readonly shellFamily?: ShellFamily;
  /** 安全 S3:创建该会话的 MCP 调用方身份(见 MainTerminalSession.controllerToken). */
  readonly controllerToken?: string;
}

export interface GetAllFilter {
  readonly ownerWindowId: number;
}

export function assertOwnerWindowId(value: unknown): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`[terminal-sessions] invalid ownerWindowId: ${String(value)}`);
  }
}

export type SessionsSubscriber = (
  snapshot: readonly MainTerminalSession[],
) => void;

// ── 内部状态 ────────────────────────────────────────────────────

const sessions = new Map<string, MainTerminalSession>();
const subscribers = new Set<SessionsSubscriber>();
const titleCounter: Map<number, number> = new Map();
let cachedSnapshot: readonly MainTerminalSession[] | null = null;
const cachedSnapshotsByOwner = new Map<number, readonly MainTerminalSession[]>();

// 边界(E235,E230 数量上限族):终端会话数量上限。每个 session 占一个**真实 PTY 子进程** + 4MiB ring
// buffer + throttle interval + metadata 快照广播 + Dock panel —— 数量上限族里最重的资源。此前 add() 无
// 数量上限,terminal:create / MCP create_session 可持续创建直至拖垮 main/renderer/系统。add() 是 PTY
// spawn **前**的 reservation 单一漏斗(IPC handler 先 add 再 service.createTerminal),在此加全局 +
// 每窗口双闸 → 超限抛 TOO_MANY_TERMINALS,既不入 sessions 也不会 spawn PTY(不漏子进程)。计数含 live 与
// exited-retained(都在 Map 中,remove/removeByOwner 后释放)。值远超任何正常人工/agent 并发终端数。
// E292:常量移到 shared/terminal-session-limits,renderer ingress(terminal.store filterByOwnerWindow)
// 复用同值作计数闸(此前 renderer 无对应上限)。

/** 边界(E235):某窗口当前会话数(含 live 与 exited-retained)。sessions 已封顶后 O(≤256)。 */
function sessionCountForWindow(ownerWindowId: number): number {
  let n = 0;
  for (const s of sessions.values()) {
    if (s.ownerWindowId === ownerWindowId) n += 1;
  }
  return n;
}

// ── helpers ────────────────────────────────────────────────────

function snapshot(): readonly MainTerminalSession[] {
  if (cachedSnapshot !== null) return cachedSnapshot;

  const out: MainTerminalSession[] = [];
  for (const session of sessions.values()) out.push(session);
  cachedSnapshot = out;
  return out;
}

function invalidateSnapshotCache(): void {
  cachedSnapshot = null;
  cachedSnapshotsByOwner.clear();
}

function notify(): void {
  const snap = snapshot();
  for (const fn of subscribers) {
    try {
      fn(snap);
    } catch (err) {
      // subscriber 抛错不应破坏其它 subscriber 与本次 mutation 的可见性
       
      console.warn('[terminal-sessions] subscriber threw', err);
    }
  }
}

// ── public API ─────────────────────────────────────────────────

export function add(input: AddSessionInput): void {
  assertOwnerWindowId(input.ownerWindowId);
  if (sessions.has(input.id)) {
    throw Object.assign(
      new Error(`terminal session duplicate: ${input.id}`),
      { code: ERROR_CODES.TERMINAL_SESSION_DUPLICATE },
    );
  }
  // 边界(E235):全局 + 每窗口会话数量双闸。在 spawn PTY 前的 reservation 处拒绝,超限不入 sessions、
  // 不触发后续 PTY spawn(IPC handler 见到 add 抛错即不调 createTerminal)→ 不漏真实子进程。
  if (sessions.size >= MAX_TERMINAL_SESSIONS_GLOBAL) {
    throw Object.assign(
      new Error(
        `terminal session global limit (${MAX_TERMINAL_SESSIONS_GLOBAL}) reached`,
      ),
      { code: ERROR_CODES.TOO_MANY_TERMINALS },
    );
  }
  if (
    sessionCountForWindow(input.ownerWindowId) >=
    MAX_TERMINAL_SESSIONS_PER_WINDOW
  ) {
    throw Object.assign(
      new Error(
        `terminal session per-window limit (${MAX_TERMINAL_SESSIONS_PER_WINDOW}) reached`,
      ),
      { code: ERROR_CODES.TOO_MANY_TERMINALS },
    );
  }
  const session: MainTerminalSession = {
    id: input.id,
    title: input.title,
    cwd: input.cwd,
    originHint: input.originHint,
    ...(input.agentLabel !== undefined ? { agentLabel: input.agentLabel } : {}),
    ...(input.scoped !== undefined ? { scoped: input.scoped } : {}),
    createdAt: Date.now(),
    exitCode: null,
    ownerWindowId: input.ownerWindowId,
    ...(input.attachTarget !== undefined ? { attachTarget: input.attachTarget } : {}),
    ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.shellFamily !== undefined ? { shellFamily: input.shellFamily } : {}),
    ...(input.controllerToken !== undefined
      ? { controllerToken: input.controllerToken }
      : {}),
  };
  sessions.set(input.id, session);
  invalidateSnapshotCache();
  notify();
}

export function get(id: string): MainTerminalSession | undefined {
  return sessions.get(id);
}

/** 安全 S3:会话的创建方 MCP 身份(controllerToken),不存在/未由 MCP 创建 → null. */
export function getController(id: string): string | null {
  return sessions.get(id)?.controllerToken ?? null;
}

export function getAll(filter?: GetAllFilter): readonly MainTerminalSession[] {
  if (!filter) return snapshot();
  const cached = cachedSnapshotsByOwner.get(filter.ownerWindowId);
  if (cached !== undefined) return cached;

  const out: MainTerminalSession[] = [];
  for (const s of sessions.values()) {
    if (s.ownerWindowId === filter.ownerWindowId) out.push(s);
  }
  cachedSnapshotsByOwner.set(filter.ownerWindowId, out);
  return out;
}

export function remove(id: string): void {
  if (!sessions.has(id)) return;
  sessions.delete(id);
  invalidateSnapshotCache();
  notify();
}

export function updateCwd(id: string, cwd: string): void {
  const cur = sessions.get(id);
  if (!cur || cur.cwd === cwd) return;
  sessions.set(id, { ...cur, cwd });
  invalidateSnapshotCache();
  notify();
}

export function removeByOwner(ownerWindowId: number): readonly string[] {
  // 窗口关闭:它的 default-title 计数器永不再用(BrowserWindow.id 单调不复用),
  // 一并清掉。否则 titleCounter 随窗口开关单调泄漏(removeByOwner 旧实现只清
  // sessions)。在 early-return 之前清,覆盖「窗口建过终端但已逐个 remove」的情况。
  // 见第十六轮 P2-AS。
  titleCounter.delete(ownerWindowId);
  const removed: string[] = [];
  for (const [id, s] of sessions) {
    if (s.ownerWindowId === ownerWindowId) removed.push(id);
  }
  if (removed.length === 0) return removed;
  for (const id of removed) sessions.delete(id);
  invalidateSnapshotCache();
  notify();
  return removed;
}

export function setExited(id: string, exitCode: number): void {
  const cur = sessions.get(id);
  if (!cur) return;
  sessions.set(id, { ...cur, exitCode });
  invalidateSnapshotCache();
  notify();
}

/**
 * 单调递增的默认标题。remove 中间 session 不重用编号 — 修复 renderer 旧
 * `sessions.length + 1` 实现的撞号 bug。
 */
export function nextDefaultTitle(ownerWindowId: number): string {
  const cur = titleCounter.get(ownerWindowId) ?? 0;
  const next = cur + 1;
  titleCounter.set(ownerWindowId, next);
  return `Terminal ${next}`;
}

export function subscribe(fn: SessionsSubscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** 测试用:清空所有内部状态. */
export function _reset(): void {
  sessions.clear();
  subscribers.clear();
  titleCounter.clear();
  invalidateSnapshotCache();
}

// 边界(E235)测试用:会话数量上限常量。
export const MAX_TERMINAL_SESSIONS_GLOBAL_FOR_TEST = MAX_TERMINAL_SESSIONS_GLOBAL;
export const MAX_TERMINAL_SESSIONS_PER_WINDOW_FOR_TEST =
  MAX_TERMINAL_SESSIONS_PER_WINDOW;
