import { create } from 'zustand';
import { asRecord } from '../../electron/shared/as-record';
import { coApi } from '@/lib/co-api';
import {
  DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX,
  type DebugBreakpoint,
  type DebugScope,
  type DebugStackFrame,
  type DebugVariable,
  type DebugViewEvent,
} from '../../electron/shared/debug-view-channels';

export type {
  DebugBreakpoint,
  DebugScope,
  DebugStackFrame,
  DebugVariable,
} from '../../electron/shared/debug-view-channels';

export interface DebugStoppedLocation {
  readonly reason: string;
  readonly stopSeq: number;
  readonly file?: string;
  readonly line?: number;
}

export interface DebugSessionShadow {
  readonly id: string;
  readonly breakpoints: readonly DebugBreakpoint[];
  readonly frames: readonly DebugStackFrame[];
  readonly scopes: readonly DebugScope[];
  readonly variableRefs: ReadonlyMap<number, readonly DebugVariable[]>;
  readonly stopped?: DebugStoppedLocation;
  readonly lastStoppedOrder: number;
}

type DebugState = {
  sessions: ReadonlyMap<string, DebugSessionShadow>;
  activeSessionId: string | null;
  stoppedOrder: number;
  ingestEvent: (event: DebugViewEvent) => Promise<void>;
  loadVariables: (
    sessionId: string,
    variablesReference: number,
  ) => Promise<readonly DebugVariable[]>;
};

const EMPTY_DEBUG_SESSIONS = new Map<string, DebugSessionShadow>();
let unsubscribeDebugEvents: (() => void) | null = null;
/** 同步代际:resetDebugStoreForTest 之后迟到的 subscribe 快照不写回。 */
let debugSyncGeneration = 0;

function emptySession(id: string): DebugSessionShadow {
  return {
    id,
    breakpoints: [],
    frames: [],
    scopes: [],
    variableRefs: new Map(),
    lastStoppedOrder: 0,
  };
}

function getOrCreateSession(
  sessions: ReadonlyMap<string, DebugSessionShadow>,
  sessionId: string,
): DebugSessionShadow {
  return sessions.get(sessionId) ?? emptySession(sessionId);
}

function asFrame(value: unknown): DebugStackFrame | null {
  const raw = asRecord(value);
  if (
    typeof raw.id !== 'number' ||
    typeof raw.name !== 'string' ||
    typeof raw.line !== 'number'
  ) {
    return null;
  }
  return {
    id: raw.id,
    name: raw.name,
    ...(typeof raw.source_path === 'string'
      ? { source_path: raw.source_path }
      : {}),
    line: raw.line,
  };
}

function asScope(value: unknown): DebugScope | null {
  const raw = asRecord(value);
  if (
    typeof raw.name !== 'string' ||
    typeof raw.variables_reference !== 'number' ||
    typeof raw.expensive !== 'boolean'
  ) {
    return null;
  }
  return {
    name: raw.name,
    variables_reference: raw.variables_reference,
    expensive: raw.expensive,
  };
}

function asVariable(value: unknown): DebugVariable | null {
  const raw = asRecord(value);
  if (typeof raw.name !== 'string' || typeof raw.value !== 'string') return null;
  return {
    name: raw.name,
    value: raw.value,
    ...(typeof raw.variables_reference === 'number'
      ? { variables_reference: raw.variables_reference }
      : {}),
  };
}

function asBreakpoint(value: unknown): DebugBreakpoint | null {
  const raw = asRecord(value);
  if (
    typeof raw.file !== 'string' ||
    typeof raw.line !== 'number' ||
    typeof raw.verified !== 'boolean'
  ) {
    return null;
  }
  return {
    file: raw.file,
    line: raw.line,
    verified: raw.verified,
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
  };
}

interface SessionSnapshot {
  readonly id: string;
  readonly stop?: { readonly stopSeq: number; readonly reason: string; readonly threadId?: number };
  /** 按 source 分组(file → 该 source 的完整集合),总数已按上限截断。 */
  readonly breakpointsBySource: ReadonlyMap<string, readonly DebugBreakpoint[]>;
}

// subscribe 快照来自 IPC:逐字段校验(同 asFrame 等),断点总数按 main 同一上限截断。
function asSessionSnapshot(value: unknown): SessionSnapshot | null {
  const raw = asRecord(value);
  if (typeof raw.session_id !== 'string') return null;
  const stopRaw = asRecord(raw.stop);
  const stop =
    typeof stopRaw.stopSeq === 'number' && typeof stopRaw.reason === 'string'
      ? {
          stopSeq: stopRaw.stopSeq,
          reason: stopRaw.reason,
          ...(typeof stopRaw.threadId === 'number' ? { threadId: stopRaw.threadId } : {}),
        }
      : undefined;
  const breakpointsBySource = new Map<string, readonly DebugBreakpoint[]>();
  let budget = DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX;
  for (const group of Array.isArray(raw.breakpointsBySource) ? raw.breakpointsBySource : []) {
    const groupRaw = asRecord(group);
    if (typeof groupRaw.file !== 'string' || !Array.isArray(groupRaw.breakpoints)) continue;
    const breakpoints = (groupRaw.breakpoints as readonly unknown[])
      .map(asBreakpoint)
      .filter((bp): bp is DebugBreakpoint => bp !== null)
      .slice(0, budget);
    budget -= breakpoints.length;
    breakpointsBySource.set(groupRaw.file, breakpoints);
  }
  return { id: raw.session_id, ...(stop ? { stop } : {}), breakpointsBySource };
}

function updateActiveSession(
  sessions: ReadonlyMap<string, DebugSessionShadow>,
): string | null {
  let best: DebugSessionShadow | null = null;
  for (const session of sessions.values()) {
    if (!session.stopped) continue;
    if (!best || session.lastStoppedOrder > best.lastStoppedOrder) best = session;
  }
  return best?.id ?? null;
}

// stopSeq:发起本次拉取的那一停。连续 step 时上一停的 stack/scopes 可能晚到,回写前比对,过期丢弃
//(否则旧栈帧与旧停靠行会写进新一停,编辑器高亮停在错误的行)。
async function pullStackAndScopes(
  sessionId: string,
  stopSeq: number,
  threadId?: number,
): Promise<void> {
  const stack = await coApi.debug.getStack({ sessionId, threadId });
  if (!stack.ok) return;
  const frames = Array.isArray(asRecord(stack.data).frames)
    ? (asRecord(stack.data).frames as readonly unknown[])
        .map(asFrame)
        .filter((frame): frame is DebugStackFrame => frame !== null)
    : [];
  const topFrame = frames[0];

  let scopes: readonly DebugScope[] = [];
  if (topFrame) {
    const scopeResult = await coApi.debug.getScopes({
      sessionId,
      frameId: topFrame.id,
    });
    if (scopeResult.ok && Array.isArray(asRecord(scopeResult.data).scopes)) {
      scopes = (asRecord(scopeResult.data).scopes as readonly unknown[])
        .map(asScope)
        .filter((scope): scope is DebugScope => scope !== null);
    }
  }

  useDebugStore.setState((state) => {
    const current = state.sessions.get(sessionId);
    if (!current || current.stopped?.stopSeq !== stopSeq) return state;
    const nextSession: DebugSessionShadow = {
      ...current,
      frames,
      scopes,
      stopped: current.stopped
        ? {
            ...current.stopped,
            ...(topFrame?.source_path !== undefined
              ? { file: topFrame.source_path }
              : {}),
            ...(topFrame?.line !== undefined ? { line: topFrame.line } : {}),
          }
        : undefined,
    };
    const sessions = new Map(state.sessions);
    sessions.set(sessionId, nextSession);
    return { sessions };
  });
}

export const useDebugStore = create<DebugState>((set, get) => ({
  sessions: EMPTY_DEBUG_SESSIONS,
  activeSessionId: null,
  stoppedOrder: 0,

  ingestEvent: async (event) => {
    if (event.type === 'breakpoints-changed') {
      set((state) => {
        const current = getOrCreateSession(state.sessions, event.sessionId);
        // main 推的是该 source 的完整集合(adapter 校正后的行号):整组替换该文件的记录、其它文件保留。
        // 按 file+行号增量合并时,同一逻辑断点被重新校正到别的行会留下旧红点。文件分组与 main 一致(===)。
        const breakpoints = [
          ...current.breakpoints.filter((bp) => bp.file !== event.file),
          ...event.breakpoints,
        ];
        const nextSession: DebugSessionShadow = {
          ...current,
          breakpoints,
        };
        const sessions = new Map(state.sessions);
        sessions.set(event.sessionId, nextSession);
        return { sessions };
      });
      return;
    }

    if (event.type === 'stopped') {
      const nextOrder = get().stoppedOrder + 1;
      set((state) => {
        const current = getOrCreateSession(state.sessions, event.sessionId);
        const nextSession: DebugSessionShadow = {
          ...current,
          frames: [],
          scopes: [],
          variableRefs: new Map(),
          stopped: {
            reason: event.reason,
            stopSeq: event.stopSeq,
          },
          lastStoppedOrder: nextOrder,
        };
        const sessions = new Map(state.sessions);
        sessions.set(event.sessionId, nextSession);
        return {
          sessions,
          activeSessionId: event.sessionId,
          stoppedOrder: nextOrder,
        };
      });
      await pullStackAndScopes(event.sessionId, event.stopSeq, event.threadId);
      return;
    }

    if (event.type === 'continued') {
      set((state) => {
        const current = state.sessions.get(event.sessionId);
        if (!current) return state;
        const nextSession: DebugSessionShadow = {
          ...current,
          frames: [],
          scopes: [],
          variableRefs: new Map(),
          stopped: undefined,
        };
        const sessions = new Map(state.sessions);
        sessions.set(event.sessionId, nextSession);
        return {
          sessions,
          activeSessionId:
            state.activeSessionId === event.sessionId
              ? updateActiveSession(sessions)
              : state.activeSessionId,
        };
      });
      return;
    }

    if (event.type === 'terminated') {
      set((state) => {
        if (!state.sessions.has(event.sessionId)) return state;
        const sessions = new Map(state.sessions);
        sessions.delete(event.sessionId);
        return {
          sessions,
          activeSessionId:
            state.activeSessionId === event.sessionId
              ? updateActiveSession(sessions)
              : state.activeSessionId,
        };
      });
    }
  },

  loadVariables: async (sessionId, variablesReference) => {
    const session = get().sessions.get(sessionId);
    const stopSeq = session?.stopped?.stopSeq;
    // 同一停内同一 reference 只拉一次(variableRefs 在 stopped / continued 时清空)。
    const cached = session?.variableRefs.get(variablesReference);
    if (cached) return cached;

    const result = await coApi.debug.getVariables({
      sessionId,
      variablesReference,
      maxDepth: 1,
    });
    if (!result.ok) return [];
    const variables = Array.isArray(asRecord(result.data).variables)
      ? (asRecord(result.data).variables as readonly unknown[])
          .map(asVariable)
          .filter((variable): variable is DebugVariable => variable !== null)
      : [];

    set((state) => {
      const current = state.sessions.get(sessionId);
      // 发起后已进入下一停(或已继续运行)→ 不回写:reference 号跨停复用,旧值会挂到新一停同号下。
      if (!current || current.stopped?.stopSeq !== stopSeq) return state;
      const variableRefs = new Map(current.variableRefs);
      variableRefs.set(variablesReference, variables);
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        ...current,
        variableRefs,
      });
      return { sessions };
    });
    return variables;
  },
}));

/**
 * 用 subscribe 快照初始化 store(renderer 重载后 store 为空、main 只推增量事件)。先订阅事件、后取快照:
 * 快照送达前已收到事件的会话(touched),事件比快照新 —— 不改其停点,只补它尚无记录的 source 的断点;
 * 已不在 store 里的(已结束 / 已继续的未知会话)不复活。
 */
function hydrateFromSnapshot(data: unknown, touched: ReadonlySet<string>): void {
  const snapshots = (Array.isArray(asRecord(data).sessions) ? (asRecord(data).sessions as readonly unknown[]) : [])
    .map(asSessionSnapshot)
    .filter((snapshot): snapshot is SessionSnapshot => snapshot !== null);
  const pulls: Array<{ id: string; stopSeq: number; threadId?: number }> = [];
  useDebugStore.setState((state) => {
    const sessions = new Map(state.sessions);
    let stoppedOrder = state.stoppedOrder;
    for (const snapshot of snapshots) {
      const current = sessions.get(snapshot.id);
      if (touched.has(snapshot.id)) {
        if (!current) continue;
        const known = new Set(current.breakpoints.map((bp) => bp.file));
        const missing = [...snapshot.breakpointsBySource]
          .filter(([file]) => !known.has(file))
          .flatMap(([, breakpoints]) => breakpoints);
        if (missing.length > 0) {
          sessions.set(snapshot.id, { ...current, breakpoints: [...current.breakpoints, ...missing] });
        }
        continue;
      }
      const base = emptySession(snapshot.id);
      const breakpoints = [...snapshot.breakpointsBySource.values()].flat();
      if (!snapshot.stop) {
        sessions.set(snapshot.id, { ...base, breakpoints });
        continue;
      }
      stoppedOrder += 1;
      sessions.set(snapshot.id, {
        ...base,
        breakpoints,
        stopped: {
          reason: snapshot.stop.reason,
          stopSeq: snapshot.stop.stopSeq,
        },
        lastStoppedOrder: stoppedOrder,
      });
      pulls.push({
        id: snapshot.id,
        stopSeq: snapshot.stop.stopSeq,
        ...(snapshot.stop.threadId !== undefined ? { threadId: snapshot.stop.threadId } : {}),
      });
    }
    return {
      sessions,
      stoppedOrder,
      activeSessionId: state.activeSessionId ?? updateActiveSession(sessions),
    };
  });
  for (const pull of pulls) void pullStackAndScopes(pull.id, pull.stopSeq, pull.threadId);
}

// 幂等(模块级单例):renderer 启动入口(main-app init)尽早调用一次,DebugPanel 挂载时再调也无副作用。
// 不能只靠面板挂载:main 只推增量事件,面板没开时到达的停点 / 断点会永久丢失。
// renderer 重载(Cmd+R)后 store 为空:subscribe 返回本窗口会话的快照(停点 + 断点),据此恢复。
export function startDebugStoreSync(): void {
  if (unsubscribeDebugEvents) return;
  const generation = ++debugSyncGeneration;
  const touched = new Set<string>();
  let snapshotApplied = false;
  unsubscribeDebugEvents = coApi.debug.onEvent((event) => {
    if (!snapshotApplied) touched.add(event.sessionId);
    void useDebugStore.getState().ingestEvent(event);
  });
  void coApi.debug.subscribe().then(
    (result) => {
      snapshotApplied = true;
      if (!result.ok || generation !== debugSyncGeneration) return;
      hydrateFromSnapshot(result.data, touched);
    },
    () => {
      snapshotApplied = true;
    },
  );
}

export function resetDebugStoreForTest(): void {
  unsubscribeDebugEvents?.();
  unsubscribeDebugEvents = null;
  debugSyncGeneration += 1;
  useDebugStore.setState({
    sessions: EMPTY_DEBUG_SESSIONS,
    activeSessionId: null,
    stoppedOrder: 0,
  });
}
