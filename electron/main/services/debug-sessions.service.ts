export type DebugTeardownState = 'active' | 'tearing_down' | 'done';
export type DebugRuntimeState = 'starting' | 'running' | 'stopped' | 'terminated';

export const MAX_DEBUG_SESSIONS_GLOBAL = 32;
export const MAX_DEBUG_SESSIONS_PER_WINDOW = 8;

export interface DebugSession {
  readonly id: string;
  readonly ownerWindowId: number;
  readonly controllerToken: string;
  readonly state: DebugTeardownState;
  readonly runtimeState: DebugRuntimeState;
  readonly program: string;
  readonly cwd: string;
  readonly name?: string;
  readonly adapterPid?: number;
  readonly adapterPgid?: number;
  readonly systemProcessIds: readonly number[];
  readonly childSessionCount: number;
  readonly socketPath?: string;
  readonly stopSeq: number;
  readonly runSeq: number;
  readonly pausedEpoch: number;
  readonly currentThreadId?: number;
  readonly currentFrameId?: number;
  readonly scopeRefs: readonly number[];
  readonly stoppedReason?: string;
  readonly createdAt: number;
}

export interface AddDebugSessionInput {
  readonly id: string;
  readonly ownerWindowId: number;
  readonly controllerToken: string;
  readonly program: string;
  readonly cwd: string;
  readonly name?: string;
  readonly adapterPid?: number;
  readonly socketPath?: string;
}

const sessions = new Map<string, DebugSession>();
const EMPTY_DEBUG_SESSIONS: readonly DebugSession[] = [];

function assertOwnerWindowId(value: unknown): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`[debug-sessions] invalid ownerWindowId: ${String(value)}`);
  }
}

function sessionCountForWindow(ownerWindowId: number): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.ownerWindowId === ownerWindowId && session.state !== 'done') {
      count += 1;
    }
  }
  return count;
}

function activeSessionCount(): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.state !== 'done') count += 1;
  }
  return count;
}

export function add(input: AddDebugSessionInput): DebugSession {
  assertOwnerWindowId(input.ownerWindowId);
  if (sessions.has(input.id)) {
    throw new Error(`debug session duplicate: ${input.id}`);
  }
  if (activeSessionCount() >= MAX_DEBUG_SESSIONS_GLOBAL) {
    throw new Error(
      `debug session global limit (${MAX_DEBUG_SESSIONS_GLOBAL}) reached`,
    );
  }
  if (sessionCountForWindow(input.ownerWindowId) >= MAX_DEBUG_SESSIONS_PER_WINDOW) {
    throw new Error(
      `debug session per-window limit (${MAX_DEBUG_SESSIONS_PER_WINDOW}) reached`,
    );
  }

  const session: DebugSession = {
    id: input.id,
    ownerWindowId: input.ownerWindowId,
    controllerToken: input.controllerToken,
    state: 'active',
    runtimeState: 'starting',
    program: input.program,
    cwd: input.cwd,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.adapterPid !== undefined ? { adapterPid: input.adapterPid } : {}),
    systemProcessIds: [],
    childSessionCount: 0,
    ...(input.socketPath !== undefined ? { socketPath: input.socketPath } : {}),
    stopSeq: 0,
    runSeq: 0,
    pausedEpoch: 0,
    scopeRefs: [],
    createdAt: Date.now(),
  };
  sessions.set(input.id, session);
  return session;
}

export function get(id: string): DebugSession | undefined {
  return sessions.get(id);
}

export function list(): readonly DebugSession[] {
  if (sessions.size === 0) return EMPTY_DEBUG_SESSIONS;
  return Array.from(sessions.values()).filter((session) => session.state !== 'done');
}

export function byOwner(ownerWindowId: number): readonly DebugSession[] {
  const out = list().filter((session) => session.ownerWindowId === ownerWindowId);
  return out.length === 0 ? EMPTY_DEBUG_SESSIONS : out;
}

export function byController(controllerToken: string): readonly DebugSession[] {
  const out = list().filter(
    (session) => session.controllerToken === controllerToken,
  );
  return out.length === 0 ? EMPTY_DEBUG_SESSIONS : out;
}

export function update(
  id: string,
  patch: Partial<Omit<DebugSession, 'id' | 'createdAt'>>,
): DebugSession | undefined {
  const cur = sessions.get(id);
  if (!cur) return undefined;
  const next: DebugSession = { ...cur, ...patch };
  sessions.set(id, next);
  return next;
}

export function addSystemProcessId(id: string, pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const cur = sessions.get(id);
  if (!cur || cur.systemProcessIds.includes(pid)) return;
  update(id, { systemProcessIds: [...cur.systemProcessIds, pid] });
}

export function addScopeRefs(id: string, refs: readonly number[]): void {
  const cur = sessions.get(id);
  if (!cur) return;
  const next = new Set(cur.scopeRefs);
  for (const ref of refs) {
    if (Number.isInteger(ref) && ref > 0) next.add(ref);
  }
  update(id, { scopeRefs: Array.from(next) });
}

export function tryMarkTearingDown(id: string): boolean {
  const cur = sessions.get(id);
  if (!cur || cur.state !== 'active') return false;
  sessions.set(id, { ...cur, state: 'tearing_down' });
  return true;
}

export function markDone(id: string): void {
  const cur = sessions.get(id);
  if (!cur) return;
  sessions.set(id, { ...cur, state: 'done', runtimeState: 'terminated' });
}

export function remove(id: string): void {
  sessions.delete(id);
}

export function _reset(): void {
  sessions.clear();
}
