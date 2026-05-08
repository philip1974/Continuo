// Terminal session metadata 真相源(main 进程,Phase 1 搬迁后启用)。
// PTY 进程仍由 terminal.service.ts 持;本 service 持 metadata + emitter,
// 通过 IPC sessions_changed 推送给 renderer。
//
// BDD: src/__tests__/terminal-sessions-service/

export interface MainTerminalSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly originHint: 'user' | 'agent';
  readonly agentLabel?: string;
  readonly createdAt: number;
  readonly exitCode: number | null;
}

export interface AddSessionInput {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly originHint: 'user' | 'agent';
  readonly agentLabel?: string;
}

export type SessionsSubscriber = (
  snapshot: readonly MainTerminalSession[],
) => void;

// ── 内部状态 ────────────────────────────────────────────────────

const sessions = new Map<string, MainTerminalSession>();
const subscribers = new Set<SessionsSubscriber>();
let titleCounter = 0;

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
    createdAt: Date.now(),
    exitCode: null,
  };
  sessions.set(input.id, session);
  notify();
}

export function get(id: string): MainTerminalSession | undefined {
  return sessions.get(id);
}

export function getAll(): readonly MainTerminalSession[] {
  return snapshot();
}

export function remove(id: string): void {
  if (!sessions.has(id)) return;
  sessions.delete(id);
  notify();
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
export function nextDefaultTitle(): string {
  titleCounter += 1;
  return `Terminal ${titleCounter}`;
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
  titleCounter = 0;
}
