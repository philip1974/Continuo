import { create } from 'zustand';
import { coApi } from '@/lib/co-api';
import type { DebugViewEvent } from '../../electron/shared/debug-view-channels';

export interface DebugBreakpoint {
  readonly file: string;
  readonly line: number;
  readonly column?: number;
  readonly verified: boolean;
  readonly message?: string;
}

export interface DebugStackFrame {
  readonly id: number;
  readonly name: string;
  readonly source_path?: string;
  readonly line: number;
  readonly column?: number;
}

export interface DebugScope {
  readonly name: string;
  readonly variables_reference: number;
  readonly expensive: boolean;
}

export interface DebugVariable {
  readonly name: string;
  readonly value: string;
  readonly type?: string;
  readonly variables_reference?: number;
  readonly truncated?: boolean;
  readonly children?: readonly DebugVariable[];
}

export interface DebugStoppedLocation {
  readonly reason: string;
  readonly stopSeq: number;
  readonly pausedEpoch: number;
  readonly threadId?: number;
  readonly file?: string;
  readonly line?: number;
}

export interface DebugSessionShadow {
  readonly id: string;
  readonly breakpoints: readonly DebugBreakpoint[];
  readonly frames: readonly DebugStackFrame[];
  readonly scopes: readonly DebugScope[];
  readonly variableRefs: ReadonlyMap<number, readonly DebugVariable[]>;
  readonly variablesCache: ReadonlyMap<string, readonly DebugVariable[]>;
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
  reset: () => void;
};

const EMPTY_DEBUG_SESSIONS = new Map<string, DebugSessionShadow>();
let unsubscribeDebugEvents: (() => void) | null = null;

function emptySession(id: string): DebugSessionShadow {
  return {
    id,
    breakpoints: [],
    frames: [],
    scopes: [],
    variableRefs: new Map(),
    variablesCache: new Map(),
    lastStoppedOrder: 0,
  };
}

function getOrCreateSession(
  sessions: ReadonlyMap<string, DebugSessionShadow>,
  sessionId: string,
): DebugSessionShadow {
  return sessions.get(sessionId) ?? emptySession(sessionId);
}

function variableCacheKey(
  sessionId: string,
  pausedEpoch: number,
  variablesReference: number,
): string {
  return `${sessionId}:${pausedEpoch}:${variablesReference}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
    ...(typeof raw.column === 'number' ? { column: raw.column } : {}),
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
    ...(typeof raw.type === 'string' ? { type: raw.type } : {}),
    ...(typeof raw.variables_reference === 'number'
      ? { variables_reference: raw.variables_reference }
      : {}),
    ...(typeof raw.truncated === 'boolean' ? { truncated: raw.truncated } : {}),
  };
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

async function pullStackAndScopes(sessionId: string, threadId?: number): Promise<void> {
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
    if (!current) return state;
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
        const nextSession: DebugSessionShadow = {
          ...current,
          breakpoints: [event.breakpoint],
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
          variablesCache: new Map(),
          stopped: {
            reason: event.reason,
            stopSeq: event.stopSeq,
            pausedEpoch: event.stopSeq,
            ...(event.threadId !== undefined ? { threadId: event.threadId } : {}),
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
      await pullStackAndScopes(event.sessionId, event.threadId);
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
          variablesCache: new Map(),
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
    const pausedEpoch = session?.stopped?.pausedEpoch ?? 0;
    const cacheKey = variableCacheKey(sessionId, pausedEpoch, variablesReference);
    const cached = session?.variablesCache.get(cacheKey);
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
      if (!current) return state;
      const variableRefs = new Map(current.variableRefs);
      variableRefs.set(variablesReference, variables);
      const variablesCache = new Map(current.variablesCache);
      variablesCache.set(cacheKey, variables);
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, {
        ...current,
        variableRefs,
        variablesCache,
      });
      return { sessions };
    });
    return variables;
  },

  reset: () =>
    set({
      sessions: EMPTY_DEBUG_SESSIONS,
      activeSessionId: null,
      stoppedOrder: 0,
    }),
}));

export function startDebugStoreSync(): void {
  if (unsubscribeDebugEvents) return;
  unsubscribeDebugEvents = coApi.debug.onEvent((event) => {
    void useDebugStore.getState().ingestEvent(event);
  });
  void coApi.debug.subscribe();
}

export function resetDebugStoreForTest(): void {
  unsubscribeDebugEvents?.();
  unsubscribeDebugEvents = null;
  useDebugStore.getState().reset();
}
