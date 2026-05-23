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

/** topic-05: agent 在 MCP create_session 时指定 attach 目标。 */
export type AttachTarget =
  | { kind: 'active' }
  | { kind: 'panel'; panelId: string }
  | { kind: 'window'; windowId: number };

export interface MainTerminalSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly originHint: 'user' | 'agent';
  readonly agentLabel?: string;
  readonly scoped?: boolean;
  readonly createdAt: number;
  readonly exitCode: number | null;
  // Issue #28 Phase 1:owner BrowserWindow.id。renderer 不自报,
  // 由 IPC create handler 从 event.sender 推断后传入。
  readonly ownerWindowId: number;
  /** topic-05: agent attach hint;renderer 用此决定 attach 落到哪个 panel。 */
  readonly attachTarget?: AttachTarget;
  /**
   * 创建时所在 workspace 的根目录绝对路径。undefined = 未选 workspace 或
   * agent 创建(全局)。renderer 端按当前 workspaceRoot 过滤可见 sessions:
   *   visible = (workspaceRoot === current) || workspaceRoot === undefined
   * 主进程只存,不做过滤 — 渲染层决定 UI 可见性。
   */
  readonly workspaceRoot?: string;
}

export interface AddSessionInput {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly originHint: 'user' | 'agent';
  readonly agentLabel?: string;
  readonly scoped?: boolean;
  readonly ownerWindowId: number;
  readonly attachTarget?: AttachTarget;
  readonly workspaceRoot?: string;
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

// ── helpers ────────────────────────────────────────────────────

function snapshot(): readonly MainTerminalSession[] {
  return Array.from(sessions.values());
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
  };
  sessions.set(input.id, session);
  notify();
}

export function get(id: string): MainTerminalSession | undefined {
  return sessions.get(id);
}

export function getAll(filter?: GetAllFilter): readonly MainTerminalSession[] {
  const snap = snapshot();
  if (!filter) return snap;
  return snap.filter((s) => s.ownerWindowId === filter.ownerWindowId);
}

export function remove(id: string): void {
  if (!sessions.has(id)) return;
  sessions.delete(id);
  notify();
}

export function updateCwd(id: string, cwd: string): void {
  const cur = sessions.get(id);
  if (!cur || cur.cwd === cwd) return;
  sessions.set(id, { ...cur, cwd });
  notify();
}

export function removeByOwner(ownerWindowId: number): readonly string[] {
  const removed: string[] = [];
  for (const [id, s] of sessions) {
    if (s.ownerWindowId === ownerWindowId) removed.push(id);
  }
  if (removed.length === 0) return removed;
  for (const id of removed) sessions.delete(id);
  notify();
  return removed;
}

export function setExited(id: string, exitCode: number): void {
  const cur = sessions.get(id);
  if (!cur) return;
  sessions.set(id, { ...cur, exitCode });
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
}
