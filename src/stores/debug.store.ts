import { create } from 'zustand';
import { asRecord } from '../../electron/shared/as-record';
import { coApi } from '@/lib/co-api';
import {
  capGroupsNewestFirst,
  DEBUG_USER_BREAKPOINTS_MAX,
  DEBUG_VIEW_OUTPUT_ENTRIES_MAX,
  DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX,
  type DebugBreakpoint,
  type DebugControlAction,
  type DebugOutputEntry,
  type DebugScope,
  type DebugStackFrame,
  type DebugUserBreakpoint,
  type DebugUserBreakpointsEvent,
  type DebugVariable,
  type DebugViewEvent,
} from '../../electron/shared/debug-view-channels';
import { createLatestGuard } from '@/lib/latest-wins';
import { notifyFailure, notifyThrownError } from '@/notifications/notify-thrown-error';
import { notify } from '@/notifications/notify';
import { t } from '@/i18n';

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

/**
 * 调试控制台的一行:程序输出(category = DAP output 类别 stdout / stderr / console / important …),或用户在控制台的
 * 求值(input = 输入的表达式、result = 结果、error = 求值失败)。id 在 store 内唯一(列表 key)。
 */
export interface DebugConsoleLine {
  readonly id: number;
  readonly category: string;
  readonly text: string;
  /**
   * 求值结果是对象(DAP evaluate 回 variablesReference > 0):可在控制台展开(VSCode REPL 同),子变量经 loadVariables 懒加载。
   * reference 只在求值时的那一停有效(stopSeq);继续运行 / 下一停后不再可展开。
   */
  readonly variablesReference?: number;
  readonly stopSeq?: number;
}

/** 刚结束的会话留下的控制台内容(VSCode:会话结束后调试控制台保留输出,直到下一个会话开始)。 */
export interface DebugEndedConsole {
  readonly sessionId: string;
  readonly label?: string;
  readonly lines: readonly DebugConsoleLine[];
}

export interface DebugSessionShadow {
  readonly id: string;
  /** 面板显示的会话名(main 随事件 / 快照发来:launch 的 name,无则程序文件名);缺省时面板回退 id。 */
  readonly label?: string;
  readonly breakpoints: readonly DebugBreakpoint[];
  readonly frames: readonly DebugStackFrame[];
  readonly scopes: readonly DebugScope[];
  readonly variableRefs: ReadonlyMap<number, readonly DebugVariable[]>;
  /** 已加载的 reference 还有下一页时的起点(main 回的 next_start);无条目 = 已取完。随 variableRefs 一起清空。 */
  readonly variableNextStart?: ReadonlyMap<number, number>;
  readonly stopped?: DebugStoppedLocation;
  readonly lastStoppedOrder: number;
  /** 调试控制台(最近 DEBUG_VIEW_OUTPUT_ENTRIES_MAX 行);缺省 = 空。 */
  readonly console?: readonly DebugConsoleLine[];
  /** 控制台前面有行被截掉(只保留最近的;或 main 那边已丢弃,输出 seq 不连续)。 */
  readonly consoleTruncated?: boolean;
  /** 已收到的最后一条输出的 seq(判断是否有输出没送到)。 */
  readonly lastOutputSeq?: number;
}

type DebugState = {
  sessions: ReadonlyMap<string, DebugSessionShadow>;
  activeSessionId: string | null;
  stoppedOrder: number;
  /** 本窗口的用户断点(编辑器 gutter 设的;main 推完整列表)。 */
  userBreakpoints: readonly DebugUserBreakpoint[];
  /** 最近结束的会话的控制台(没有存活会话时面板仍显示它)。新会话开始时清空。 */
  endedConsole: DebugEndedConsole | null;
  /**
   * 经 stopped 事件实时到达的最新一停(停下时自动打开 / 定位用,见 debug-auto-reveal;subscribe 快照恢复的停点不算)。
   */
  lastLiveStop: {
    readonly sessionId: string;
    readonly stopSeq: number;
    readonly reason: string;
    /**
     * 这一停由用户自己的调试操作引起(本窗口调试工具栏 / F5 F6 F10 F11 ⇧F11 发出 继续 / 暂停 / 单步 后到达的第一停);
     * 否则(agent 经 MCP 驱动、程序自己撞上断点 …)为 false。停下时自动定位据此决定是否把焦点交给编辑器(见 debug-auto-reveal)。
     */
    readonly byUser: boolean;
  } | null;
  ingestEvent: (event: DebugViewEvent | DebugUserBreakpointsEvent) => Promise<void>;
  /** 调试工具栏 / 按键:对会话发 继续 / 暂停 / 单步 / 停止;失败提示,不抛。 */
  control: (sessionId: string, action: DebugControlAction) => Promise<void>;
  /** 编辑器 gutter:设置 / 删除 file 第 line 行的断点(窗口级用户断点 + 同步到本窗口会话);失败提示,不抛。 */
  setBreakpointAt: (file: string, line: number, enabled: boolean) => Promise<void>;
  /** 调试控制台求值:输入与结果都追加到该会话的控制台;停住时在首帧求值。 */
  evaluate: (sessionId: string, expression: string) => Promise<void>;
  /** 清除控制台(VSCode「清除控制台」):sessionId = 该会话的控制台;null = 刚结束的会话留下的控制台。 */
  clearConsole: (sessionId: string | null) => void;
  loadVariables: (
    sessionId: string,
    variablesReference: number,
  ) => Promise<readonly DebugVariable[]>;
  /** 从该 reference 记录的 next_start 取下一页并追加;没有下一页则什么也不做。 */
  loadMoreVariables: (sessionId: string, variablesReference: number) => Promise<void>;
};

const EMPTY_DEBUG_SESSIONS = new Map<string, DebugSessionShadow>();
let unsubscribeDebugEvents: (() => void) | null = null;
/** 同步代际:resetDebugStoreForTest 之后迟到的 subscribe 快照不写回。 */
const debugSyncGuard = createLatestGuard();

function emptySession(id: string): DebugSessionShadow {
  return {
    id,
    breakpoints: [],
    frames: [],
    scopes: [],
    variableRefs: new Map(),
    lastStoppedOrder: 0,
    console: [],
  };
}

let nextConsoleLineId = 1;

/**
 * 用户在本窗口发出了 继续 / 暂停 / 单步、还没等到下一停的会话:其下一停记为用户引起(lastLiveStop.byUser)。发出前登记
 *(stopped 事件可能先于 control 的 IPC 应答到达),发送失败 / 会话结束时撤销。runtime only。
 */
const userDrivenSessions = new Set<string>();

/** 追加控制台行并按上限保留最近的(截掉时记 consoleTruncated)。 */
function appendConsole(
  session: DebugSessionShadow,
  lines: readonly Omit<DebugConsoleLine, 'id'>[],
): DebugSessionShadow {
  if (lines.length === 0) return session;
  const added = lines.map((line) => ({ ...line, id: nextConsoleLineId++ }));
  const all = [...(session.console ?? []), ...added];
  const overflow = all.length - DEBUG_VIEW_OUTPUT_ENTRIES_MAX;
  return {
    ...session,
    console: overflow > 0 ? all.slice(overflow) : all,
    ...(overflow > 0 || session.consoleTruncated ? { consoleTruncated: true } : {}),
  };
}

/** 追加程序输出:seq 与上次收到的不连续(main 环形缓冲 / 合批已丢弃一部分)→ 同样记为截断。 */
function appendOutputEntries(session: DebugSessionShadow, entries: readonly DebugOutputEntry[]): DebugSessionShadow {
  const first = entries[0];
  if (first === undefined) return session;
  const gap = first.seq > (session.lastOutputSeq ?? -1) + 1;
  const next = appendConsole(
    session,
    entries.map((entry) => ({ category: entry.category, text: entry.output })),
  );
  return { ...next, lastOutputSeq: entries[entries.length - 1]!.seq, ...(gap ? { consoleTruncated: true } : {}) };
}

const DEBUG_OUTPUT_TEXT_MAX = 64 * 1024;

function asOutputEntries(value: unknown): DebugOutputEntry[] {
  if (!Array.isArray(value)) return [];
  return (value as readonly unknown[])
    .slice(-DEBUG_VIEW_OUTPUT_ENTRIES_MAX)
    .flatMap((item) => {
      const raw = asRecord(item);
      return typeof raw.seq === 'number' && typeof raw.category === 'string' && typeof raw.output === 'string'
        ? [{ seq: raw.seq, category: raw.category.slice(0, 64), output: raw.output.slice(0, DEBUG_OUTPUT_TEXT_MAX) }]
        : [];
    });
}

function asUserBreakpoints(value: unknown): DebugUserBreakpoint[] {
  if (!Array.isArray(value)) return [];
  return (value as readonly unknown[]).slice(0, DEBUG_USER_BREAKPOINTS_MAX).flatMap((item) => {
    const raw = asRecord(item);
    return typeof raw.file === 'string' && typeof raw.line === 'number' && Number.isInteger(raw.line) && raw.line >= 1
      ? [{ file: raw.file, line: raw.line }]
      : [];
  });
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
    ...(typeof raw.column === 'number' ? { column: raw.column } : {}),
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
  };
}

// debug 推送事件来自 IPC:与 subscribe 快照同形,同样逐字段校验(asBreakpoint)、断点数按同一上限截断
//(E168-E175 push ingress 守卫族)。不合法 → null,调用方 drop。
function asDebugViewEvent(value: unknown): DebugViewEvent | DebugUserBreakpointsEvent | null {
  const raw = asRecord(value);
  if (raw.type === 'user-breakpoints-changed') {
    return Array.isArray(raw.breakpoints)
      ? { type: 'user-breakpoints-changed', breakpoints: asUserBreakpoints(raw.breakpoints) }
      : null;
  }
  if (typeof raw.sessionId !== 'string') return null;
  const sessionId = raw.sessionId;
  const label = asLabel(raw.label);
  switch (raw.type) {
    case 'breakpoints-changed':
      if (typeof raw.file !== 'string' || !Array.isArray(raw.breakpoints)) return null;
      return {
        type: 'breakpoints-changed',
        sessionId,
        ...label,
        file: raw.file,
        breakpoints: (raw.breakpoints as readonly unknown[])
          .map(asBreakpoint)
          .filter((bp): bp is DebugBreakpoint => bp !== null)
          .slice(0, DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX),
      };
    case 'stopped':
      if (typeof raw.stopSeq !== 'number' || typeof raw.reason !== 'string') return null;
      return { type: 'stopped', sessionId, ...label, stopSeq: raw.stopSeq, reason: raw.reason };
    case 'started':
      return { type: 'started', sessionId, ...label };
    case 'output':
      return Array.isArray(raw.entries) ? { type: 'output', sessionId, entries: asOutputEntries(raw.entries) } : null;
    case 'continued':
      return { type: raw.type, sessionId };
    case 'terminated':
      return typeof raw.adapterCrashed === 'string'
        ? { type: 'terminated', sessionId, adapterCrashed: raw.adapterCrashed.slice(0, DEBUG_ADAPTER_CRASH_DETAIL_MAX) }
        : { type: 'terminated', sessionId };
    default:
      return null;
  }
}

const DEBUG_SESSION_LABEL_MAX = 256;
/** adapter 意外退出说明(main 给的是 `signal: X` / `exit code: N` / `connection closed`)的长度上限。 */
const DEBUG_ADAPTER_CRASH_DETAIL_MAX = 256;
/** IPC 来的会话名:非空字符串才收(封顶长度),否则不带。 */
function asLabel(value: unknown): { readonly label?: string } {
  return typeof value === 'string' && value !== '' ? { label: value.slice(0, DEBUG_SESSION_LABEL_MAX) } : {};
}

interface SessionSnapshot {
  readonly id: string;
  readonly label?: string;
  readonly stop?: { readonly stopSeq: number; readonly reason: string };
  /** 按 source 分组(file → 该 source 的完整集合),总数已按上限截断。 */
  readonly breakpointsBySource: ReadonlyMap<string, readonly DebugBreakpoint[]>;
  readonly output: readonly DebugOutputEntry[];
}

// subscribe 快照来自 IPC:逐字段校验(同 asFrame 等),断点总数按 main 同一上限截断。
function asSessionSnapshot(value: unknown): SessionSnapshot | null {
  const raw = asRecord(value);
  if (typeof raw.session_id !== 'string') return null;
  const stopRaw = asRecord(raw.stop);
  const stop =
    typeof stopRaw.stopSeq === 'number' && typeof stopRaw.reason === 'string'
      ? { stopSeq: stopRaw.stopSeq, reason: stopRaw.reason }
      : undefined;
  const parsed: Array<{ file: string; breakpoints: readonly DebugBreakpoint[] }> = [];
  for (const group of Array.isArray(raw.breakpointsBySource) ? raw.breakpointsBySource : []) {
    const groupRaw = asRecord(group);
    if (typeof groupRaw.file !== 'string' || !Array.isArray(groupRaw.breakpoints)) continue;
    // 先按上限截掉组内超长部分,避免畸形巨数组整段 map
    const breakpoints = (groupRaw.breakpoints as readonly unknown[])
      .slice(0, DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX + 1)
      .map(asBreakpoint)
      .filter((bp): bp is DebugBreakpoint => bp !== null);
    parsed.push({ file: groupRaw.file, breakpoints });
  }
  // 与 main 同一截断规则(最新优先,末尾组最新)。
  const capped = capGroupsNewestFirst(
    parsed.map((g) => g.breakpoints),
    DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX,
  );
  const offset = parsed.length - capped.length;
  const breakpointsBySource = new Map<string, readonly DebugBreakpoint[]>();
  capped.forEach((breakpoints, i) => breakpointsBySource.set(parsed[offset + i]!.file, breakpoints));
  return {
    id: raw.session_id,
    ...asLabel(raw.label),
    ...(stop ? { stop } : {}),
    breakpointsBySource,
    output: asOutputEntries(raw.output),
  };
}

/** 按 file 分组(组序 = 首次出现顺序;store 内同一文件的断点本就相邻)。 */
function groupBreakpointsByFile(list: readonly DebugBreakpoint[]): DebugBreakpoint[][] {
  const groups = new Map<string, DebugBreakpoint[]>();
  for (const bp of list) {
    const group = groups.get(bp.file);
    if (group) group.push(bp);
    else groups.set(bp.file, [bp]);
  }
  return [...groups.values()];
}

/**
 * Debug 面板显示的会话:已停下的活动会话(activeSessionId),否则最近创建的会话(运行中)。activeSessionId 只指向已停下
 * 的会话 —— 面板若只认它,会话 continue 后显示「无调试会话」、断点页也进不去,「运行中」分支永远走不到。
 */
export function selectDisplayedSession(state: {
  readonly activeSessionId: string | null;
  readonly sessions: ReadonlyMap<string, DebugSessionShadow>;
}): DebugSessionShadow | undefined {
  if (state.activeSessionId !== null) {
    const active = state.sessions.get(state.activeSessionId);
    if (active) return active;
  }
  let latest: DebugSessionShadow | undefined;
  for (const session of state.sessions.values()) latest = session;
  return latest;
}

/**
 * activeSessionId 的唯一来源:最近停下的会话(lastStoppedOrder 最大)。stopped / continued / terminated / 快照 hydrate
 * 四处都用它重算(此前各写一套「是否沿用旧值」的条件,hydrate 后与排序依据不一致)。
 */
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
// 失败(ok:false / reject)提示 —— 但仅当仍停在发起拉取的那一停:continue / 下一停后迟到的旧失败不提示(避免刷屏)。
// 自身吞掉 reject,调用方 void 调用不会产生未处理 rejection。
function isCurrentStop(sessionId: string, stopSeq: number): boolean {
  return useDebugStore.getState().sessions.get(sessionId)?.stopped?.stopSeq === stopSeq;
}

async function pullStackAndScopes(sessionId: string, stopSeq: number): Promise<void> {
  let stack: Awaited<ReturnType<typeof coApi.debug.getStack>>;
  try {
    stack = await coApi.debug.getStack({ sessionId });
  } catch (err) {
    if (isCurrentStop(sessionId, stopSeq)) notifyThrownError(err);
    return;
  }
  if (!stack.ok) {
    if (isCurrentStop(sessionId, stopSeq)) notifyFailure(stack);
    return;
  }
  const frames = Array.isArray(asRecord(stack.data).frames)
    ? (asRecord(stack.data).frames as readonly unknown[])
        .map(asFrame)
        .filter((frame): frame is DebugStackFrame => frame !== null)
    : [];
  const topFrame = frames[0];
  // 首帧的作用域随栈帧一起返回(main 取完栈帧接着取,取不到给空数组)。
  const scopes: readonly DebugScope[] = Array.isArray(asRecord(stack.data).scopes)
    ? (asRecord(stack.data).scopes as readonly unknown[])
        .map(asScope)
        .filter((scope): scope is DebugScope => scope !== null)
    : [];

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

  userBreakpoints: [],
  endedConsole: null,
  lastLiveStop: null,

  ingestEvent: async (event) => {
    if (event.type === 'user-breakpoints-changed') {
      set({ userBreakpoints: event.breakpoints });
      return;
    }

    if (event.type === 'started') {
      set((state) => {
        const current = getOrCreateSession(state.sessions, event.sessionId);
        const sessions = new Map(state.sessions);
        sessions.set(event.sessionId, { ...current, ...(event.label !== undefined ? { label: event.label } : {}) });
        // 新会话开始:上一个会话留下的控制台不再显示(VSCode 同)。
        return { sessions, endedConsole: null };
      });
      return;
    }

    if (event.type === 'output') {
      set((state) => {
        const current = state.sessions.get(event.sessionId);
        if (!current) return state;
        const sessions = new Map(state.sessions);
        sessions.set(event.sessionId, appendOutputEntries(current, event.entries));
        return { sessions };
      });
      return;
    }

    if (event.type === 'breakpoints-changed') {
      set((state) => {
        const current = getOrCreateSession(state.sessions, event.sessionId);
        // main 推的是该 source 的完整集合(adapter 校正后的行号):整组替换该文件的记录、其它文件保留。
        // 按 file+行号增量合并时,同一逻辑断点被重新校正到别的行会留下旧红点。文件分组与 main 一致(===)。
        // 会话断点总数按 subscribe 快照同一上限、同一规则截断(capGroupsNewestFirst:本文件挪到末尾 = 最新,
        // 超限时截掉最早发过事件的文件;单个事件已按此上限截断,本次事件完整保留)。显示顺序不变。
        const others = current.breakpoints.filter((bp) => bp.file !== event.file);
        const breakpoints = capGroupsNewestFirst(
          [...groupBreakpointsByFile(others), event.breakpoints],
          DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX,
        ).flat();
        const nextSession: DebugSessionShadow = {
          ...current,
          ...(event.label !== undefined ? { label: event.label } : {}),
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
          ...(event.label !== undefined ? { label: event.label } : {}),
          frames: [],
          scopes: [],
          variableRefs: new Map(),
          variableNextStart: new Map(),
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
          activeSessionId: updateActiveSession(sessions),
          stoppedOrder: nextOrder,
          lastLiveStop: {
            sessionId: event.sessionId,
            stopSeq: event.stopSeq,
            reason: event.reason,
            byUser: userDrivenSessions.delete(event.sessionId),
          },
        };
      });
      await pullStackAndScopes(event.sessionId, event.stopSeq);
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
          variableNextStart: new Map(),
          stopped: undefined,
        };
        const sessions = new Map(state.sessions);
        sessions.set(event.sessionId, nextSession);
        return {
          sessions,
          activeSessionId: updateActiveSession(sessions),
        };
      });
      return;
    }

    if (event.type === 'terminated') {
      userDrivenSessions.delete(event.sessionId);
      // VSCode debugService onDidEndAdapter:adapter 意外退出 → 错误通知「Debug adapter process has terminated unexpectedly」。
      if (event.adapterCrashed !== undefined) {
        notify.error(t('panels.debug.adapter_crashed', { detail: event.adapterCrashed }));
      }
      set((state) => {
        const ended = state.sessions.get(event.sessionId);
        if (!ended) return state;
        const sessions = new Map(state.sessions);
        sessions.delete(event.sessionId);
        return {
          sessions,
          activeSessionId: updateActiveSession(sessions),
          // 有输出的会话结束后保留其控制台(程序跑完即结束时仍能看到输出)。
          ...(ended.console !== undefined && ended.console.length > 0
            ? {
                endedConsole: {
                  sessionId: ended.id,
                  ...(ended.label !== undefined ? { label: ended.label } : {}),
                  lines: ended.console,
                },
              }
            : {}),
        };
      });
    }
  },

  control: async (sessionId, action) => {
    const resumes = action !== 'stop';
    if (resumes) userDrivenSessions.add(sessionId);
    try {
      const result = await coApi.debug.control({ sessionId, action });
      if (!result.ok) {
        if (resumes) userDrivenSessions.delete(sessionId);
        notifyFailure(result);
      }
    } catch (err) {
      if (resumes) userDrivenSessions.delete(sessionId);
      notifyThrownError(err);
    }
  },

  setBreakpointAt: async (file, line, enabled) => {
    try {
      const result = await coApi.debug.setUserBreakpoint({ file, line, enabled });
      if (!result.ok) notifyFailure(result);
    } catch (err) {
      notifyThrownError(err);
    }
  },

  evaluate: async (sessionId, expression) => {
    const appendLine = (line: Omit<DebugConsoleLine, 'id'>) =>
      set((state) => {
        const current = state.sessions.get(sessionId);
        if (!current) return state;
        const sessions = new Map(state.sessions);
        sessions.set(sessionId, appendConsole(current, [line]));
        return { sessions };
      });
    appendLine({ category: 'input', text: expression });
    // 停住时在首帧求值(VSCode REPL 在当前聚焦的帧求值;面板不能切帧,即首帧),运行中全局求值。
    const before = get().sessions.get(sessionId);
    const frameId = before?.frames[0]?.id;
    const stopSeq = before?.stopped?.stopSeq;
    try {
      const result = await coApi.debug.evaluate({
        sessionId,
        expression,
        ...(frameId !== undefined ? { frameId } : {}),
      });
      if (result.ok) {
        const data = asRecord(result.data);
        const ref = data.variables_reference;
        // 对象结果可展开:仅当求值发起时停住、且结果回来时仍是同一停(reference 只在这一停有效)。
        const expandable =
          typeof ref === 'number' && Number.isInteger(ref) && ref > 0 && stopSeq !== undefined && isCurrentStop(sessionId, stopSeq);
        appendLine({
          category: 'result',
          text: typeof data.result === 'string' ? data.result : '',
          ...(expandable ? { variablesReference: ref, stopSeq } : {}),
        });
      } else {
        appendLine({ category: 'error', text: result.message ?? result.code });
      }
    } catch (err) {
      appendLine({ category: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  },

  clearConsole: (sessionId) =>
    set((state) => {
      if (sessionId === null) {
        return state.endedConsole === null ? state : { endedConsole: { ...state.endedConsole, lines: [] } };
      }
      const current = state.sessions.get(sessionId);
      if (!current) return state;
      const { consoleTruncated: _truncated, ...rest } = current;
      const sessions = new Map(state.sessions);
      sessions.set(sessionId, { ...rest, console: [] });
      return { sessions };
    }),

  loadVariables: async (sessionId, variablesReference) => {
    const session = get().sessions.get(sessionId);
    // 同一停内同一 reference 只拉一次(variableRefs 在 stopped / continued 时清空);后续页走 loadMoreVariables。
    const cached = session?.variableRefs.get(variablesReference);
    if (cached) return cached;
    return (await fetchVariablesPage(sessionId, variablesReference, session?.stopped?.stopSeq, 0)) ?? [];
  },

  loadMoreVariables: async (sessionId, variablesReference) => {
    const session = get().sessions.get(sessionId);
    const start = session?.variableNextStart?.get(variablesReference);
    if (start === undefined) return;
    await fetchVariablesPage(sessionId, variablesReference, session?.stopped?.stopSeq, start);
  },
}));


/**
 * 取 reference 从 start 起的一页变量(start 0 = 首页,> 0 = 追加到已缓存的前几页之后),同时记下 next_start。
 * 用户点「加载作用域」/「加载更多」触发:失败(ok:false / reject)提示并返回 null,不向面板抛出。与 pullStackAndScopes
 * 同规则:发起后已继续运行 / 进入下一停的迟到失败不提示、迟到结果不回写(variablesReference 只在本停有效、号跨停复用)。
 */
async function fetchVariablesPage(
  sessionId: string,
  variablesReference: number,
  stopSeq: number | undefined,
  start: number,
): Promise<readonly DebugVariable[] | null> {
  const stillCurrent = (): boolean => stopSeq !== undefined && isCurrentStop(sessionId, stopSeq);
  let result: Awaited<ReturnType<typeof coApi.debug.getVariables>>;
  try {
    result = await coApi.debug.getVariables({
      sessionId,
      variablesReference,
      ...(start > 0 ? { start } : {}),
    });
  } catch (err) {
    if (stillCurrent()) notifyThrownError(err);
    return null;
  }
  if (!result.ok) {
    if (stillCurrent()) notifyFailure(result);
    return null;
  }
  const data = asRecord(result.data);
  const page = Array.isArray(data.variables)
    ? (data.variables as readonly unknown[])
        .map(asVariable)
        .filter((variable): variable is DebugVariable => variable !== null)
    : [];
  const nextStart =
    typeof data.next_start === 'number' && Number.isInteger(data.next_start) && data.next_start > start
      ? data.next_start
      : undefined;

  let variables = page;
  useDebugStore.setState((state) => {
    const current = state.sessions.get(sessionId);
    if (!current || current.stopped?.stopSeq !== stopSeq) return state;
    // 追加页只接在仍等着这一页的缓存后面(重复点击 / 已被首页重取时丢弃,防重复条目)。
    if (start > 0 && current.variableNextStart?.get(variablesReference) !== start) return state;
    variables = start > 0 ? [...(current.variableRefs.get(variablesReference) ?? []), ...page] : page;
    const variableRefs = new Map(current.variableRefs);
    variableRefs.set(variablesReference, variables);
    const variableNextStart = new Map(current.variableNextStart);
    if (nextStart === undefined) variableNextStart.delete(variablesReference);
    else variableNextStart.set(variablesReference, nextStart);
    const sessions = new Map(state.sessions);
    sessions.set(sessionId, { ...current, variableRefs, variableNextStart });
    return { sessions };
  });
  return variables;
}

/**
 * 用 subscribe 快照初始化 store(renderer 重载后 store 为空、main 只推增量事件)。先订阅事件、后取快照:
 * 快照送达前已收到事件的会话(touched),事件比快照新 —— 不改其停点,只补它尚无记录的 source 的断点;
 * 已不在 store 里的(已结束 / 已继续的未知会话)不复活。
 */
function hydrateFromSnapshot(data: unknown, touched: ReadonlySet<string>, userBreakpointsTouched: boolean): void {
  const snapshots = (Array.isArray(asRecord(data).sessions) ? (asRecord(data).sessions as readonly unknown[]) : [])
    .map(asSessionSnapshot)
    .filter((snapshot): snapshot is SessionSnapshot => snapshot !== null);
  const pulls: Array<{ id: string; stopSeq: number }> = [];
  useDebugStore.setState((state) => {
    const sessions = new Map(state.sessions);
    // 快照里的已停会话实际停在订阅之前,比订阅后经 stopped 事件记序(从 1 起递增)的会话都早 → 序号取 ≤ 0,
    // 排在事件会话之前(快照内部按快照顺序)。
    let snapshotOrder = -snapshots.length;
    for (const snapshot of snapshots) {
      const current = sessions.get(snapshot.id);
      if (touched.has(snapshot.id)) {
        if (!current) continue;
        const known = new Set(current.breakpoints.map((bp) => bp.file));
        const missing = [...snapshot.breakpointsBySource]
          .filter(([file]) => !known.has(file))
          .map(([, breakpoints]) => breakpoints);
        if (missing.length > 0) {
          // 本端没收到过事件的文件更早(或从未)发出 → 排在前,刚收到事件的在后(与 main 快照顺序一致);
          // 合并后同样按上限最新优先截断(此前直接拼接,可超上限)。
          const breakpoints = capGroupsNewestFirst(
            [...missing, ...groupBreakpointsByFile(current.breakpoints)],
            DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX,
          ).flat();
          sessions.set(snapshot.id, { ...current, breakpoints });
        }
        continue;
      }
      const base: DebugSessionShadow = appendOutputEntries(
        {
          ...emptySession(snapshot.id),
          ...(snapshot.label !== undefined ? { label: snapshot.label } : {}),
        },
        snapshot.output,
      );
      const breakpoints = [...snapshot.breakpointsBySource.values()].flat();
      if (!snapshot.stop) {
        sessions.set(snapshot.id, { ...base, breakpoints });
        continue;
      }
      snapshotOrder += 1;
      sessions.set(snapshot.id, {
        ...base,
        breakpoints,
        stopped: {
          reason: snapshot.stop.reason,
          stopSeq: snapshot.stop.stopSeq,
        },
        lastStoppedOrder: snapshotOrder,
      });
      pulls.push({ id: snapshot.id, stopSeq: snapshot.stop.stopSeq });
    }
    return {
      sessions,
      activeSessionId: updateActiveSession(sessions),
      // 快照之前已收到 user-breakpoints-changed 事件:事件更新,不用快照覆盖。
      ...(userBreakpointsTouched ? {} : { userBreakpoints: asUserBreakpoints(asRecord(data).userBreakpoints) }),
    };
  });
  for (const pull of pulls) void pullStackAndScopes(pull.id, pull.stopSeq);
}

// 幂等(模块级单例):renderer 启动入口(main-app init)尽早调用一次;重复调用无副作用(只订阅一次)。
// 不能只靠面板挂载:main 只推增量事件,面板没开时到达的停点 / 断点会永久丢失。
// renderer 重载(Cmd+R)后 store 为空:subscribe 返回本窗口会话的快照(停点 + 断点),据此恢复。
export function startDebugStoreSync(): void {
  if (unsubscribeDebugEvents) return;
  const isLatest = debugSyncGuard.begin();
  const touched = new Set<string>();
  let userBreakpointsTouched = false;
  let snapshotApplied = false;
  unsubscribeDebugEvents = coApi.debug.onEvent((payload) => {
    const event = asDebugViewEvent(payload);
    if (!event) {
      console.warn('[debug] invalid debug view event, dropped', payload);
      return;
    }
    if (!snapshotApplied) {
      if (event.type === 'user-breakpoints-changed') userBreakpointsTouched = true;
      else touched.add(event.sessionId);
    }
    useDebugStore.getState().ingestEvent(event).catch(notifyThrownError);
  });
  void coApi.debug.subscribe().then(
    (result) => {
      snapshotApplied = true;
      if (!result.ok || !isLatest()) return;
      hydrateFromSnapshot(result.data, touched, userBreakpointsTouched);
    },
    () => {
      snapshotApplied = true;
    },
  );
}

export function resetDebugStoreForTest(): void {
  userDrivenSessions.clear();
  unsubscribeDebugEvents?.();
  unsubscribeDebugEvents = null;
  debugSyncGuard.begin(); // 作废在途的 subscribe 快照
  useDebugStore.setState({
    sessions: EMPTY_DEBUG_SESSIONS,
    activeSessionId: null,
    stoppedOrder: 0,
    userBreakpoints: [],
    endedConsole: null,
    lastLiveStop: null,
  });
}
