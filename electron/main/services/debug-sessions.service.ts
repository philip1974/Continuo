import { assertOwnerWindowId } from '../lib/assert-owner-window-id';

export type DebugTeardownState = 'active' | 'tearing_down' | 'done';
export type DebugRuntimeState = 'starting' | 'running' | 'stopped' | 'terminated';

const MAX_DEBUG_SESSIONS_GLOBAL = 32;
const MAX_DEBUG_SESSIONS_PER_WINDOW = 8;
/**
 * 每个顶层调试会话同时存活 / 握手中的 child session 上限(嵌套 worker 的 child 共用同一计数)。child 由被调试
 * 程序驱动(worker_threads / 伪造的 inspector target 都会让 js-debug 发 startDebugging),每个占一个 socket fd
 * 与 DapClient;无上限时被调试程序可耗尽 main 进程的 fd。
 */
export const MAX_DEBUG_CHILD_SESSIONS_PER_SESSION = 32;

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
  readonly stopSeq: number;
  readonly runSeq: number;
  readonly pausedEpoch: number;
  readonly currentThreadId?: number;
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
}

const sessions = new Map<string, DebugSession>();
const EMPTY_DEBUG_SESSIONS: readonly DebugSession[] = [];

/**
 * 在途 launch 预占的名额(窗口 id → 份数)。launch 在 spawn adapter 之前同步预占,登记时由 add 消耗,失败 / 取消时
 * 释放:并发 launch 不会都在 spawn 前看到空余名额而同时拉起大量 adapter。
 */
const reservations = new Map<number, number>();
let reservedTotal = 0;

function sessionCountForWindow(ownerWindowId: number): number {
  let count = reservations.get(ownerWindowId) ?? 0;
  for (const session of sessions.values()) {
    if (session.ownerWindowId === ownerWindowId && session.state !== 'done') {
      count += 1;
    }
  }
  return count;
}

function activeSessionCount(): number {
  let count = reservedTotal;
  for (const session of sessions.values()) {
    if (session.state !== 'done') count += 1;
  }
  return count;
}

/** 会话数上限检查:已登记会话与在途 launch 的预占都计入。 */
export function assertCapacity(ownerWindowId: number): void {
  if (activeSessionCount() >= MAX_DEBUG_SESSIONS_GLOBAL) {
    throw new Error(
      `debug session global limit (${MAX_DEBUG_SESSIONS_GLOBAL}) reached`,
    );
  }
  if (sessionCountForWindow(ownerWindowId) >= MAX_DEBUG_SESSIONS_PER_WINDOW) {
    throw new Error(
      `debug session per-window limit (${MAX_DEBUG_SESSIONS_PER_WINDOW}) reached`,
    );
  }
}

/**
 * 名额已满时可回收的会话:最旧的已自然结束(runtimeState=terminated)、尚未拆除的会话。只在它能腾出所缺的名额时
 * 返回(本窗口满 → 只选本窗口的);未满或没有可回收者返回 undefined。
 */
export function oldestTerminatedForCapacity(ownerWindowId: number): DebugSession | undefined {
  const windowFull = sessionCountForWindow(ownerWindowId) >= MAX_DEBUG_SESSIONS_PER_WINDOW;
  if (!windowFull && activeSessionCount() < MAX_DEBUG_SESSIONS_GLOBAL) return undefined;
  let victim: DebugSession | undefined;
  for (const session of sessions.values()) {
    if (session.state !== 'active' || session.runtimeState !== 'terminated') continue;
    if (windowFull && session.ownerWindowId !== ownerWindowId) continue;
    if (victim === undefined || session.createdAt < victim.createdAt) victim = session;
  }
  return victim;
}

export interface CapacityReservation {
  readonly ownerWindowId: number;
  /** 释放预占(幂等;已被 add 消耗时为 no-op)。 */
  release(): void;
}

/**
 * 为在途 launch 预占一个名额:同步检查并计入(无 await 间隙),满了抛上限错误。launch 在 spawn adapter 之前调,
 * 登记时交给 add 消耗,失败 / 取消时 release。
 */
export function reserve(ownerWindowId: number): CapacityReservation {
  assertCapacity(ownerWindowId);
  reservations.set(ownerWindowId, (reservations.get(ownerWindowId) ?? 0) + 1);
  reservedTotal += 1;
  let released = false;
  return {
    ownerWindowId,
    release() {
      if (released) return;
      released = true;
      const held = reservations.get(ownerWindowId);
      if (held === undefined) return; // 已被 _reset 清空
      reservedTotal -= 1;
      const left = held - 1;
      if (left > 0) reservations.set(ownerWindowId, left);
      else reservations.delete(ownerWindowId);
    },
  };
}

/**
 * 登记会话。带同窗口的预占时消耗它(释放预占与登记同步完成,名额由预占保证,不再查上限);否则按上限检查。
 */
export function add(input: AddDebugSessionInput, reservation?: CapacityReservation): DebugSession {
  assertOwnerWindowId(input.ownerWindowId, 'debug-sessions');
  if (sessions.has(input.id)) {
    throw new Error(`debug session duplicate: ${input.id}`);
  }
  if (reservation?.ownerWindowId === input.ownerWindowId) reservation.release();
  else assertCapacity(input.ownerWindowId);

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
    stopSeq: 0,
    runSeq: 0,
    pausedEpoch: 0,
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

/**
 * debuggee 进程已结束:移出记录。会话(含 terminated)可能保留很久,其间 PID 会被无关进程复用,
 * 清理时不能再按它杀进程(Windows taskkill /T /F 会连带杀掉复用者的整棵进程树)。
 */
export function removeSystemProcessIds(id: string, pids: readonly number[]): void {
  const cur = sessions.get(id);
  if (!cur || pids.length === 0) return;
  const next = cur.systemProcessIds.filter((pid) => !pids.includes(pid));
  if (next.length !== cur.systemProcessIds.length) update(id, { systemProcessIds: next });
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
  reservations.clear();
  reservedTotal = 0;
}
