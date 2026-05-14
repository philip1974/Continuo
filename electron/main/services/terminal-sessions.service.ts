// Terminal session metadata 真相源(main 进程,Phase 1 搬迁后启用)。
// PTY 进程仍由 terminal.service.ts 持;本 service 持 metadata + emitter,
// 通过 IPC sessions_changed 推送给 renderer。
//
// BDD: src/__tests__/terminal-sessions-service/

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
  if (sessions.has(input.id)) {
    throw Object.assign(
      new Error(`terminal session duplicate: ${input.id}`),
      { code: 'TERMINAL_SESSION_DUPLICATE' },
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
