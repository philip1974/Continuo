import { useEffect, useRef } from 'react';
import type { AddPanelOptions, DockviewApi, IDockviewPanel } from 'dockview-react';
import type { TerminalSession } from '@/stores/terminal.store';
import { useTerminalStore } from '@/stores/terminal.store';
import { TERMINAL_PANEL_TYPE } from '@/panels/Terminal/constants';
import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { t as translate, useLocale } from '@/i18n';
import { errorCodeOf } from '../../../electron/shared/error-message';
import {
  addPanelKeepingActive,
  cancelReconcilerPanelClose,
  consumePanelCloseSuppressed,
  markPanelCloseSuppressed,
} from './wrap-panel-close';
import { mainWindowAddPosition } from './group-mru';
import { isSidePanelGroup } from './side-panel';
import { focusMainWindowFromPopout } from './main-window-focus';
import {
  panelIdFor,
  sessionIdFromPanel,
  shouldAutoCloseExitedSession,
  terminalPanelTitle,
  terminalTitleInputOf,
} from './terminal-panel-id';

export interface ReconcileInput {
  previousSessions: readonly TerminalSession[];
  nextSessions: readonly TerminalSession[];
  /**
   * 新 dock api 首次全量重建(布局恢复后挂载 / api 重建):added 都是存量 session,不是「刚创建」。
   * 不走 originHint==='user' 兜底聚焦(否则 setActive 抢走 fromJSON 恢复的活动面板),仅显式
   * pendingFocus(用户明确意图)仍聚焦;它们照常登记进 everAddedSessionIds。
   */
  hydrate?: boolean;
  /**
   * 仅配合 hydrate:恢复开始时刻(ms,与 session.createdAt 同为墙钟)。给出时 hydrate 只抑制
   * createdAt 早于它的存量 session;恢复期间新建的(如布局恢复中按 Cmd+T,其 setPendingFocus 晚于
   * 首次 reconcile 才执行、无人消费)照常走 originHint 兜底聚焦。缺省 = 抑制全部 added。
   */
  hydrateBefore?: number;
}

// pendingFocus 由 user 路径(Cmd+T / + 按钮)在 coApi.terminal.create resolve 后
// 设置;reconciler 见到对应 session 加入 store 即 setActive 一次。5s 超时自清
// 防 create 失败 / 久未触发的残留污染下个不相关的 session。
let pendingFocusSessionId: string | null = null;
let pendingFocusTimer: ReturnType<typeof setTimeout> | null = null;
const PENDING_FOCUS_TTL_MS = 5000;

// race(R25):本 app session 内「曾经出现过」的 session id。originHint==='user' 的时序兜底
// (见下方 shouldFocus 注释)只应对**首次出现**的 user terminal 生效;否则 workspace 切换时
// 旧 workspace 的 user terminal(workspaceRoot 过滤后隐藏、切回再现 = 重新进 added)会被误判
// 为新建而 setActive 抢焦点,用户可能在错误面板继续键盘输入。重现的 session 已在此 set 中 →
// 不走兜底。真正新建的 session 不在 set 中 → 保留兜底聚焦(对照 startup 注释的设计意图)。
// 不在 reconciler removed 循环里剪除:那里只看到 workspace 过滤后的可见列表,无法区分「workspace
// 隐藏」与「真关闭」,剪了会让 workspace 切回再被当首次出现重新抢焦。
// 性能(内存):只增不删会随进程生命周期内创建过的终端总数无界增长 → 由 TerminalSessionsSync 在
// 收到权威的本窗口 sessions 快照(owner 过滤后、workspace 过滤前)时调 pruneReconcilerSeenSessions
// 剪掉已不存在的 id(workspace 隐藏的 session 仍在该快照里,不受影响)。
const everAddedSessionIds = new Set<string>();

/**
 * 剪除 everAddedSessionIds 中已不在 `liveOwnedSessions` 的 id。`liveOwnedSessions` 必须是**未按
 * workspace 过滤**的本窗口 sessions 快照(TerminalSessionsSync 的 rawOwned)—— 传可见列表会把
 * workspace 隐藏的 session 剪掉,切回时被误判首次出现而抢焦(R25)。
 * `keepIds`:本轮快照里被 ingress 校验丢弃、但可能仍存活的本窗口 session id(缺失不等于真删除)——
 * 一并保留,其余已消失的 id 照常剪。
 */
export function pruneReconcilerSeenSessions(
  liveOwnedSessions: readonly TerminalSession[],
  keepIds: readonly string[],
): void {
  if (everAddedSessionIds.size === 0) return;
  const live = new Set<string>(keepIds);
  for (const s of liveOwnedSessions) live.add(s.id);
  for (const id of everAddedSessionIds) {
    if (!live.has(id)) everAddedSessionIds.delete(id);
  }
}

/** 仅测试用:当前 first-appearance 记录条数(验证有界)。 */
export function __reconcilerSeenSessionCountForTest(): number {
  return everAddedSessionIds.size;
}

/** 仅测试用:重置模块级 first-appearance 记录。 */
export function __resetReconcilerForTest(): void {
  everAddedSessionIds.clear();
  splitNext = null;
  splitBySession = null;
  pendingFocusSessionId = null;
  if (pendingFocusTimer) {
    clearTimeout(pendingFocusTimer);
    pendingFocusTimer = null;
  }
}

export function setPendingFocus(sessionId: string): void {
  pendingFocusSessionId = sessionId;
  if (pendingFocusTimer) clearTimeout(pendingFocusTimer);
  pendingFocusTimer = setTimeout(() => {
    pendingFocusSessionId = null;
    pendingFocusTimer = null;
  }, PENDING_FOCUS_TTL_MS);
}

function consumePendingFocus(sessionId: string): boolean {
  if (pendingFocusSessionId !== sessionId) return false;
  pendingFocusSessionId = null;
  if (pendingFocusTimer) {
    clearTimeout(pendingFocusTimer);
    pendingFocusTimer = null;
  }
  return true;
}

// 拆分终端(VSCode workbench.action.terminal.split,见 terminal-split):新终端落在父终端右侧(父终端在 popout 子窗 / 浮动组 →
// 加进父终端的组,留在该窗口)。create resolve 前 session id 未知 → 挂在 splitNext 上,由下一个首次出现的 user 终端认领
//(session 推送可能早于 RPC reply);resolve 后未被认领 → 按 id 记下,推送到达时认领。
interface SplitPlacement {
  readonly parentPanelId: string;
}
let splitNext: SplitPlacement | null = null;
let splitBySession: { readonly sessionId: string; readonly placement: SplitPlacement } | null = null;

/**
 * 登记「下一个新建的 user 终端是 parentPanelId 的拆分」;返回的函数在 create 落定后调用(sessionId:新终端 id,失败 null)。
 */
export function expectSplitTerminal(parentPanelId: string): (sessionId: string | null) => void {
  const placement: SplitPlacement = { parentPanelId };
  splitNext = placement;
  return (sessionId) => {
    if (splitNext !== placement) return; // 已被认领(或被更新的拆分取代)
    splitNext = null;
    if (sessionId !== null) splitBySession = { sessionId, placement };
  };
}

function takeSplitPlacement(session: TerminalSession, isFirstAppearance: boolean): SplitPlacement | null {
  if (splitBySession?.sessionId === session.id) {
    const { placement } = splitBySession;
    splitBySession = null;
    return placement;
  }
  if (splitNext === null || session.originHint !== 'user' || !isFirstAppearance) return null;
  const placement = splitNext;
  splitNext = null;
  return placement;
}

/** 拆分出的终端的落点:父终端在主窗 grid → 右侧新组(太窄放不下 → 加进父终端的组);在 popout / 浮动组 → 加进父终端的组。 */
function splitPosition(api: DockviewApi, placement: SplitPlacement | null): AddPanelOptions['position'] | undefined {
  if (placement === null) return undefined;
  const parent = api.getPanel(placement.parentPanelId);
  if (!parent) return undefined;
  const direction = isGridPanel(parent) ? splitDirectionFor(api, parent.id) : 'within';
  return { referencePanel: parent.id, direction };
}

function sessionsById(
  sessions: readonly TerminalSession[],
): Map<string, TerminalSession> {
  const byId = new Map<string, TerminalSession>();
  for (const session of sessions) byId.set(session.id, session);
  return byId;
}

export function reconcileTerminalPanels(
  api: DockviewApi,
  input: ReconcileInput,
): void {
  if (input.previousSessions === input.nextSessions) return;

  const prevById = sessionsById(input.previousSessions);
  const nextById = sessionsById(input.nextSessions);

  // race(R105):originHint==='user' 时序兜底(见下方 shouldFocus)对**每个**首次出现的 user
  // terminal 都聚焦。两个 terminal.create 并发 + session push 乱序时,较早请求的 session 可能
  // 后到 → 它仍是首次出现 → setActive() 抢焦点,覆盖已先到先聚焦的较新终端,用户键盘输入落到
  // 非预期(较旧)PTY。兜底仅应聚焦当前快照中**最新**的 user session;迟到的较旧 user session
  // 不抢焦点(显式 pendingFocus 路径=用户明确意图,不受此限,始终命中)。
  let added: TerminalSession[] | undefined;
  let addedCount = 0;
  let addedSorted = true;
  let prevAddedCreatedAt = -Infinity;
  let latestUserCreatedAt = -Infinity;
  for (const s of input.nextSessions) {
    if (!prevById.has(s.id)) {
      added ??= new Array<TerminalSession>(input.nextSessions.length);
      if (s.createdAt < prevAddedCreatedAt) addedSorted = false;
      prevAddedCreatedAt = s.createdAt;
      added[addedCount] = s;
      addedCount += 1;
    }
    if (s.originHint === 'user' && s.createdAt > latestUserCreatedAt) {
      latestUserCreatedAt = s.createdAt;
    }
  }

  if (added !== undefined) {
    added.length = addedCount;
    if (added.length > 1 && !addedSorted) {
      added.sort((a, b) => a.createdAt - b.createdAt);
    }

    let lastRefId = findLastGridTerminalPanelId(api);
    for (const session of added) {
      const panelId = panelIdFor(session.id);
      const existing = api.getPanel(panelId);
      if (existing) {
        // 面板仍在(可能正处于 reconciler 关闭的 EXIT 动画中):会话重新可见 → 撤销那次关闭,
        // 并按会话最新状态同步标题(下方标题循环只处理 prev 中已有的会话)。
        if (cancelReconcilerPanelClose(panelId)) {
          const title = deriveTitle(session);
          if (existing.api.title !== title) existing.api.setTitle(title);
        }
        if (isGridPanel(existing)) lastRefId = panelId;
        continue;
      }

      const isFirstAppearance = !everAddedSessionIds.has(session.id);
      const position =
        splitPosition(api, takeSplitPlacement(session, isFirstAppearance)) ??
        agentGroupPosition(api, session) ??
        (lastRefId
          ? { referencePanel: lastRefId, direction: splitDirectionFor(api, lastRefId) }
          : gridFallbackPosition(api));
      // user 路径走 coApi.terminal.create → main 同时 RPC reply + IPC push
      // sessions-changed。renderer 的 IPC handler 可能比 RPC await resolve 先跑,
      // 此时 user 路径的 setPendingFocus 还没执行 → pendingFocus 命不中。
      // 用 originHint === 'user' 做时序无关兜底:user 主动创建的 session 应该 focus
      // (对照 agent 创建的不抢 focus)。
      // race(R25):但兜底**仅限首次出现**的 user terminal。workspace 切换时旧 workspace 的
      // user terminal 经 workspaceRoot 过滤隐藏、切回再现 = 重新进 added,若仍走 originHint 兜底
      // 会被误判新建而抢焦点。everAddedSessionIds 记录曾出现过的 id:重现的 session 已在其中 →
      // 不兜底(除非显式 pendingFocus);真新建不在其中 → 保留兜底聚焦。
      everAddedSessionIds.add(session.id);
      // race(R105):兜底加「是快照中最新 user session」约束,迟到的较旧 user session 不抢焦点。
      const isLatestUserSession =
        session.originHint === 'user' &&
        session.createdAt === latestUserCreatedAt;
      const isHydrated =
        input.hydrate === true &&
        (input.hydrateBefore === undefined || session.createdAt < input.hydrateBefore);
      const shouldFocus =
        consumePendingFocus(session.id) ||
        (!isHydrated &&
          session.originHint === 'user' &&
          isFirstAppearance &&
          isLatestUserSession);
      const options = {
        id: panelId,
        component: TERMINAL_PANEL_TYPE,
        title: deriveTitle(session),
        params: {
          sessionId: session.id,
          originHint: session.originHint,
        },
        ...(position ? { position } : {}),
      };
      // agent 终端不抢 focus:addPanelKeepingActive(不用 `inactive: true`,见其注释)。
      // 单个面板加不进来(dockview 抛错)只报错,不中断本轮其余会话的加入 / 关闭 / 标题更新:否则订阅回调抛出,
      // previousSessions 停在旧快照,之后每轮重复 diff 再抛。
      let panel: IDockviewPanel;
      try {
        if (shouldFocus) {
          panel = api.addPanel(options);
          panel.api.setActive();
          // 用户新建的终端落在主窗而系统焦点在 popout 子窗(子窗里经菜单 / 命令面板新建终端)→ 激活主窗
          if (panel.api.location.type !== 'popout') focusMainWindowFromPopout();
        } else {
          panel = addPanelKeepingActive(api, options);
        }
      } catch (err) {
        console.warn('[dock-reconciler] addPanel failed', panelId, err);
        notify.error(translate('errors.terminal.panel_open_failed'));
        continue;
      }
      if (isGridPanel(panel)) lastRefId = panelId;
      // 如 workspace 切回时才重新可见的、期间已以 0 退出的会话。
      closePanelIfExitedCleanly(api, session);
    }
  }

  for (const session of input.previousSessions) {
    if (nextById.has(session.id)) continue;
    const panel = api.getPanel(panelIdFor(session.id));
    if (!panel) continue;
    markPanelCloseSuppressed(panel.api.id);
    panel.api.close();
  }

  for (const session of input.nextSessions) {
    if (!prevById.has(session.id)) continue;
    const title = deriveTitle(session);
    const panel = api.getPanel(panelIdFor(session.id));
    if (!panel) continue;
    if (panel.api.title !== title) {
      panel.api.setTitle(title);
    }
    if (prevById.get(session.id) !== session) closePanelIfExitedCleanly(api, session);
  }
}

/**
 * 用户终端以 0 退出 → 关闭面板(VSCode 静默关闭)。走普通 api.close(不标 suppressed):随后 onDidRemovePanel 删除 main
 * 侧会话,与用户点 × 同一路径;关闭守卫对已退出会话直接放行。
 */
function closePanelIfExitedCleanly(api: DockviewApi, session: TerminalSession): void {
  if (!shouldAutoCloseExitedSession(session)) return;
  api.getPanel(panelIdFor(session.id))?.api.close();
}

/**
 * @param hydrateBefore 本 api 布局恢复开始时刻(见 ReconcileInput.hydrateBefore);缺省 = 首次 reconcile
 *   的存量 session 全部按 hydrate 处理。
 * @param onHydrated 本 api 已按终端首个权威快照(store.hydrated)完成 reconcile,或终端同步已结算
 *   (store.settled,如初始拉取失败)时调用(每个 api 一次)。DockShell 据此解除 Splash 就绪屏障。
 */
export function useDockReconciler(
  api: DockviewApi | null,
  hydrateBefore?: number,
  onHydrated?: () => void,
): void {
  const previousSessionsRef = useRef<readonly TerminalSession[]>([]);
  const currentApiRef = useRef(api);
  currentApiRef.current = api;
  const hydrateBeforeRef = useRef(hydrateBefore);
  hydrateBeforeRef.current = hydrateBefore;
  const onHydratedRef = useRef(onHydrated);
  onHydratedRef.current = onHydrated;
  // 挂载时 store 尚未收到首个快照 → 首个快照到达那轮 reconcile 仍按 hydrate 处理:其中都是存量 session
  // (如 renderer reload 时 listSessions 晚于 layout.read 返回),不得 setActive 抢走恢复出的活动面板。
  const awaitingHydrateRef = useRef(false);
  // 本 api 是否已通知 onHydrated(Splash 放行,每个 api 一次)。
  const signalledRef = useRef(false);

  useEffect(() => {
    if (!api) return;
    const initial = useTerminalStore.getState();
    // race(R26):api 变更(dockview 重建 / onReady 重入 / HMR / StrictMode)= 一个全新的空 dock。
    // 持久布局经 sanitizePersistedDockLayout 永不含 terminal panel(终端 panel 被剥离),终端只由本
    // reconciler 从 store 建。若此处用 previousSessionsRef.current(上个 api 的旧 sessions)做 diff,
    // 现有 session 会被判「非新增」→ 不在新空 dock 补建 → 终端消失直到 sessions 再变化。新 api 一律
    // 视作空:previousSessions=[],让现有 sessions 全量重建(reconciler 内 getPanel 守卫防重复)。
    // 首次挂载 ref 本就是 [],行为不变。
    reconcileTerminalPanels(api, {
      previousSessions: [],
      nextSessions: initial.sessions,
      hydrate: true,
      ...(hydrateBefore !== undefined ? { hydrateBefore } : {}),
    });
    previousSessionsRef.current = initial.sessions;
    awaitingHydrateRef.current = !initial.hydrated;
    signalledRef.current = initial.hydrated || initial.settled;
    if (signalledRef.current) onHydratedRef.current?.();
    // hydrateBefore 与 api 由 DockShell 在同一次 setState 中设定,随 api 一起变化。
  }, [api, hydrateBefore]);

  useEffect(() => {
    return useTerminalStore.subscribe((state) => {
      const prev = previousSessionsRef.current;
      const hydrateNow = awaitingHydrateRef.current && state.hydrated;
      const dockApi = currentApiRef.current;
      // settled(初始拉取失败)只放行 Splash,不消费 awaitingHydrate:之后首个有效快照仍按 hydrate 处理。
      const signalNow =
        dockApi !== null && !signalledRef.current && (state.hydrated || state.settled);
      if (state.sessions === prev && !hydrateNow && !signalNow) return;
      if (hydrateNow) awaitingHydrateRef.current = false;

      if (dockApi && (state.sessions !== prev || hydrateNow)) {
        const before = hydrateBeforeRef.current;
        reconcileTerminalPanels(dockApi, {
          previousSessions: prev,
          nextSessions: state.sessions,
          ...(hydrateNow
            ? { hydrate: true, ...(before !== undefined ? { hydrateBefore: before } : {}) }
            : {}),
        });
      }
      previousSessionsRef.current = state.sessions;
      if (signalNow) {
        signalledRef.current = true;
        onHydratedRef.current?.();
      }
    });
    // 仅 mount 一次订阅,deps 内部用 ref 读最新值。
     
  }, []);

  // 语言切换:终端默认名 / 退出后缀跟随(幂等:标题未变不 setTitle)。
  const locale = useLocale();
  useEffect(() => {
    if (api) syncTerminalPanelTitles(api, useTerminalStore.getState().sessions);
  }, [api, locale]);
}

export interface HandleTerminalPanelRemovedInput {
  panel: Pick<IDockviewPanel, 'params'> & {
    api: Pick<IDockviewPanel['api'], 'id'>;
  };
  api: Pick<DockviewApi, 'getPanel'>;
  removeSession: (sessionId: string) => void | Promise<void>;
}

/**
 * 删除终端会话(PTY + metadata)并对失败给反馈。a11y(A128):panel 已消失但 PTY/session 可能未关,
 * ok:false 与 reject 都 notify.error(保留 console.warn 作日志)。
 */
export function removeTerminalSessionWithFeedback(sessionId: string): Promise<void> {
  return coApi.terminal.remove(sessionId).then(
    (r) => {
      if (r.ok) return;
      console.warn('[terminal-panel] remove ok=false', sessionId, r);
      notify.error(translate('errors.terminal.remove_failed', { code: r.code ?? '?' }), { code: r.code });
    },
    (err) => {
      console.warn('[terminal-panel] remove rejected', sessionId, err);
      const code = errorCodeOf(err);
      notify.error(translate('errors.terminal.remove_failed', { code }), { code });
    },
  );
}

/**
 * dockview onDidRemovePanel 的终端面板处理 —— 删会话的唯一入口。
 * - reconciler 发起的关闭(已标记 suppressed):只收敛视图,不删会话;
 * - 面板只是被移动(拖到别的 group:微任务后仍在 api 里):不删;
 * - 其余(用户关闭 / group 整体关闭等):删会话。
 */
export async function handleTerminalPanelRemoved({
  panel,
  api,
  removeSession,
}: HandleTerminalPanelRemovedInput): Promise<void> {
  const panelId = panel.api.id;
  if (consumePanelCloseSuppressed(panelId)) return;

  await Promise.resolve();
  if (api.getPanel(panelId)) return;

  const sessionId = sessionIdFromPanel(panel);
  if (!sessionId) return;
  await removeSession(sessionId);
}

/**
 * 新终端的「右侧」参照只能是主窗 grid 里的终端:popout 组(在子窗 body 下)/ floating 组作参照时,dockview addPanel
 * 走 getGridLocation(referenceGroup.element) 会抛错(popout)或并进浮动组。没有 grid 终端 → gridFallbackPosition。
 * 缺 location 的面板(旧测试桩)按 grid 处理。
 */
function isGridPanel(panel: { readonly api: { readonly location?: { readonly type: string } } }): boolean {
  return (panel.api.location?.type ?? 'grid') === 'grid';
}

/**
 * 没有 grid 终端可作参照时:活动组在主窗 grid 且可见 → 不传 position(落在活动组);活动组是 popout / floating(刚弹出过)
 * 或主窗里隐藏的 popout 引用组(整组弹出后留在 grid 里的 0 宽空组)
 * → 落在主窗一个可见的 grid 组(VSCode 新终端默认进主窗面板区)。没有可见的 grid 组 → 同主窗入口打开面板的落点
 *(mainWindowAddPosition:活动组在 popout → 主窗最近使用的组,主窗没有组则新建;活动组是浮动组 → 落在它,仍在主窗)。
 * 活动组是只含侧栏面板(搜索)的组 → 同主窗入口的落点(不进侧栏组;BDD: workspace-search 1a)。
 */
function gridFallbackPosition(api: DockviewApi): AddPanelOptions['position'] | undefined {
  const active = api.activeGroup;
  if (active && isSidePanelGroup(active)) return mainWindowAddPosition(api);
  if (!active || (active.api.location.type === 'grid' && active.api.isVisible)) return undefined;
  const grid = api.groups.find((g) => g.api.location.type === 'grid' && g.api.isVisible && !isSidePanelGroup(g));
  return grid ? { referenceGroup: grid, direction: 'within' } : mainWindowAddPosition(api);
}

/** 新终端向右分屏后每组的最小宽度(px);放不下时作为 tab 加进参照终端的组。 */
export const MIN_TERMINAL_SPLIT_WIDTH = 160;

/**
 * 新终端放在参照终端右侧(分屏)还是作为 tab 加入其组:分屏会让组窄于 MIN_TERMINAL_SPLIT_WIDTH 时加入为 tab
 * (VSCode 终端 / 编辑器组受最小宽度约束)。否则组越分越多,每组压到 dockview 的 100px 下限后总宽超出 dock,
 * 右边的组被挤出窗口右边界、看不到也够不到。
 *
 * dockview 向右加组按 Sizing.Distribute 均分:参照组位于横排里 → 横排 k 个成员均分为 k+1 份;位于纵排(或独占)→
 * 新建横排把参照组一分为二。横排各成员宽度取 splitview 写在 `.dv-view` 上的 inline width(jsdom 下也有)。
 */
function splitDirectionFor(api: DockviewApi, referencePanelId: string): 'right' | 'within' {
  const group = api.getPanel(referencePanelId)?.group;
  if (!group) return 'right';
  return widthAfterSplitRight(group) < MIN_TERMINAL_SPLIT_WIDTH ? 'within' : 'right';
}

function widthAfterSplitRight(group: DockviewApi['groups'][number]): number {
  const view = group.element.parentElement; // .dv-view
  const row = view?.parentElement?.parentElement; // .dv-view-container → .dv-split-view-container
  if (view?.classList.contains('dv-view') && row?.classList.contains('dv-horizontal')) {
    const members = [...(view.parentElement?.children ?? [])].filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el.style.display !== 'none',
    );
    const total = members.reduce((sum, el) => sum + (Number.parseFloat(el.style.width) || 0), 0);
    return total / (members.length + 1);
  }
  return group.api.width / 2;
}

/**
 * agent 终端聚在一个组里:已有 agent 终端在主窗 grid → 作为 tab 加进最后那个 agent 终端的组。否则每个 agent 终端都向右再拆一列,
 * 几个 agent 终端就把编辑器挤到不足 200px(VSCode 扩展 createTerminal 默认只在终端面板里多一个 tab,不拆分)。第一个 agent 终端
 * 照常按右侧分屏规则落位;用户的新建 / 拆分终端不受影响。
 */
function agentGroupPosition(api: DockviewApi, session: TerminalSession): AddPanelOptions['position'] | undefined {
  if (session.originHint !== 'agent') return undefined;
  for (let i = api.panels.length - 1; i >= 0; i--) {
    const panel = api.panels[i];
    if (!panel || !sessionIdFromPanel(panel) || !isGridPanel(panel)) continue;
    if ((panel.params as { originHint?: unknown } | undefined)?.originHint !== 'agent') continue;
    return { referencePanel: panel.api.id, direction: 'within' };
  }
  return undefined;
}

function findLastGridTerminalPanelId(api: DockviewApi): string | null {
  for (let i = api.panels.length - 1; i >= 0; i--) {
    const panel = api.panels[i];
    if (panel && sessionIdFromPanel(panel) && isGridPanel(panel)) return panel.api.id;
  }
  return null;
}

/**
 * 按当前语言重算全部终端面板标题(默认名「终端 N」与「(已退出)」后缀随语言切换)。TerminalPanelView 自身也会
 * 随 locale 重算,但内容未挂载的面板(lazy / 从未显示过)只能靠这里。
 */
export function syncTerminalPanelTitles(
  api: Pick<DockviewApi, 'getPanel'>,
  sessions: readonly TerminalSession[],
): void {
  for (const session of sessions) {
    const panel = api.getPanel(panelIdFor(session.id));
    if (!panel) continue;
    const title = deriveTitle(session);
    if (panel.api.title !== title) panel.api.setTitle(title);
  }
}

function deriveTitle(session: TerminalSession): string {
  return terminalPanelTitle(terminalTitleInputOf(session));
}
