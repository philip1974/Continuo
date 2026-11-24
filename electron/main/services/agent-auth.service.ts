// Agent Terminal MCP — 授权服务(main 进程,P2)。
// 反向 IPC 调度器:tool 调 requestAgentAuth → push 给 renderer →
// 等 renderer 通过 IPC respond 回 → resolve 挂起的 Promise。
//
// 「本次启动期间允许」与请求过期的权威都在 main(本文件:sessionGrants、无应答超时 / 排队兜底);renderer
//(`src/stores/agent-auth.store.ts`)只管弹窗的显示与排队,并持有授权位的界面副本(状态栏撤销入口)。

import * as crypto from 'node:crypto';
import { BrowserWindow } from 'electron';
import {
  AGENT_AUTH_CHANNELS,
  AGENT_AUTH_PROMPT_TIMEOUT_MS,
  AGENT_AUTH_QUEUE_MAX_MS,
  agentAuthDomainOf,
  type AgentAuthDecision,
  type AgentAuthRequestPayload,
} from '../../shared/agent-auth-channels';
import * as terminalSessions from './terminal-sessions.service';
import * as termService from './terminal.service';
import type { McpHost } from './mcp-host.service';
import { isPopoutUrl } from '../popout-url';
import { ERROR_CODES } from '../../shared/error-codes';
import { codedError } from '../../shared/error-message';
import { broadcastToWindows } from '../lib/broadcast';
import { cancelAgentTerminalCreates } from './agent-terminal-inflight';
import { PromptThrottle, type PromptAdmission } from '../lib/prompt-throttle';
import { onRendererDocumentGone } from '../lib/renderer-document-gone';
import { discardTerminalSession } from './terminal-discard';

// 弹窗显示 2 分钟(AGENT_AUTH_PROMPT_TIMEOUT_MS)无应答 → 默认拒绝(防 renderer 卡死时 tool Promise 永远悬挂)。
// 从请求成为窗口的显示中弹窗起算(见 markDisplayed),到点后经 CANCELLED 通知 renderer 撤掉弹窗;此前从到达起算,排在别的
// 弹窗后面的请求轮到显示时已经到期(审计实测:external 只发起不应答、冷却一结束就占住显示,窗口内合法 agent 的请求
// 排在其后,一小时内 11 次全部显示 0 秒即按超时拒绝)。排队超过 AGENT_AUTH_QUEUE_MAX_MS 仍没轮到显示 → 按取消结算。
const PROMPT_TIMEOUT_MS = AGENT_AUTH_PROMPT_TIMEOUT_MS;
const QUEUE_MAX_MS = AGENT_AUTH_QUEUE_MAX_MS;

// 边界(E229,E227/E228 pending 数量上限族):未决授权请求数量上限。requestAgentAuth 每次登记一条
// pending + 起无应答超时 timer + 向 renderer 发 IPC;此前无数量上限 —— 外部 MCP/agent 可并发 spam 大量
// 需授权的 tool 调用,renderer 同一时间只弹一个,其余全堆在 main 等满无应答超时 → pending Map + timer +
// IPC 线性放大内存/事件循环,发起的外部 agent 进程干等假死。全局 + per-window 双闸(对齐 E227
// ScopeRequestCorrelator),超限直接终态 'denied'(不入 pending、不起 timer、不发 IPC)。现为后备防线:已授权域
// 的请求在 main 直接放行、不入 pending,未授权请求受单飞约束(每个调用方类别至多一个未决),正常与恶意并发都碰不到。
const MAX_PENDING_AUTH_GLOBAL = 256; // 全局未决授权上限
const MAX_PENDING_AUTH_PER_WINDOW = 64; // 单窗口未决授权上限

/**
 * 结算原因:answer = renderer 应答(用户的决定);timeout = 无人应答;cancelled = 窗口关闭 / renderer 换文档 /
 * 排队兜底 / 发送失败;bulk-cancelled = 退出清理 / 撤销的批量结算。后两者都不计入节流;cancelled 与 timeout 逐个
 * 通知 renderer 撤掉弹窗,bulk-cancelled 不通知(退出时窗口已隐藏、无人应答;撤销另有 REVOKED 广播统一撤掉)。
 */
type SettleCause = 'answer' | 'timeout' | 'cancelled' | 'bulk-cancelled';

interface PendingAuth {
  /** 弹窗目标窗口 id(调用方窗口)。窗口关闭即按它结算。 */
  readonly windowId: number;
  /**
   * 该请求成为其窗口「显示中」弹窗的时刻;仍排在别的请求后面 → null。renderer 同一时刻只显示一个弹窗、按到达
   * 顺序排队(agent-auth.store 的 slots),所以窗口内最早的未决请求即显示中的那个(见 markDisplayed)。
   */
  shownAt: number | null;
  /** 排队中 = 排队兜底上限(到点按取消结算);显示中 = 无应答超时(到点按超时结算)。 */
  timer: ReturnType<typeof setTimeout>;
  readonly settle: (decision: AgentAuthDecision, cause: SettleCause) => void;
}
const pending = new Map<string, PendingAuth>();

// 安全:授权弹窗节流(机制见 lib/prompt-throttle.ts,与 plugin-fs scope 请求共用)。此前被拒后没有任何冷却:
// 被提示注入的 agent 循环调用任一需授权工具,每次被拒立即再调 → 弹窗关一个来一个并抢走键盘焦点,用户正在打字的
// 按键落到「允许」上。
// - subject =(目标窗口, 调用方类别 window / external),key = 授权域(terminal / debug / plugin)。external 调用方
//   (未 hello 的 stdio 客户端,可能是别的窗口里的 agent)与窗口内 agent 各自计数、各占一个未决槽,互不影响
//   (超时冷却除外,见下)。
// - 用户拒绝 → 该域冷却(30s 起,连续被拒翻倍到 5 分钟);同一 subject 连续 3 次被拒(轮换域)→ 所有域退避;
//   无人应答超时 → 该**窗口**(窗口内与 external 两个 subject)所有域冷却 30s,连续超时按窗口合并计数、翻倍到
//   5 分钟(排队兜底上限到期的按取消、不记);任一 subject 上的用户决定把该窗口的连续超时计数归零。按窗口而非按
//   subject 记:同时用窗口内与 external 两个身份交替只发起不应答,两者的超时冷却互相填补,弹窗占屏 100%。代价:
//   external 的超时也让同窗口的合法 agent 冷却(用户已接受)。拒绝冷却 / 退避 / 速率 / 单飞仍按 subject。
//   每 subject 60s 内最多 10 个弹窗;每 subject 同时最多一个未决弹窗。
//   窗口关闭 / renderer reload / 撤销 / 退出 / 发送失败结算的不算拒绝。
// - 目标窗口的 renderer 正在重新加载(见 rendererNotReady)→ 直接拒绝,只计入速率,不占未决槽、不进冷却。
// - 被节流的请求不发 IPC、不弹窗,抛 AGENT_NOT_AUTHORIZED 并在消息里说明原因与多久内不再询问。
/** 超时组 = 目标窗口(authSubject 的 `windowId:` 前缀)。 */
const newAuthThrottle = (): PromptThrottle =>
  new PromptThrottle(undefined, (subject) => subject.slice(0, subject.indexOf(':')));
let throttle = newAuthThrottle();
/**
 * 「本次启动期间允许」的唯一权威(`窗口:类别:域`):用户对某请求选「本次启动期间允许」且应答被接受时记入;已授权域的
 * 请求在 main 直接放行,不发 IPC、不弹窗、不走节流。撤销 / 退出时清空;renderer 文档被换掉(reload / 渲染进程崩溃)
 * 或窗口关闭时清掉该窗口的条目(watchAgentAuthRenderer / cancelAgentAuthByWindow)—— 与此前「renderer 状态随文档
 * 消失」同一语义。renderer 只持有用于界面(状态栏撤销入口)的副本,不参与放行判断。
 */
const sessionGrants = new Set<string>();

// 安全:renderer 文档被换掉(主窗 View 菜单 Cmd+R reload、渲染进程崩溃)时 webContents 不销毁、窗口也不关,
// win 'closed' 的清理走不到;而 renderer 侧的授权态与弹窗已随旧文档消失。不清的话:
// - 授权残留 → 该窗口已授权域的请求继续被静默放行,而用户看到的界面副本已随旧文档清空(没有撤销入口);
// - 显示中的弹窗消失,main 的未决请求留到无应答超时,调用方一直「已有未决弹窗」,之后再吃超时冷却 →
//   同窗口所有 agent 数分钟拿不到弹窗。
// 窗口创建时挂钩(main/index.ts 的 browser-window-created;首次加载也算「新文档尚未就绪」),首次向某窗口发请求时
// 兜底再挂一次(幂等);此后该 webContents 每次换文档都结算。
const rendererGoneWatched = new WeakSet<object>();
/**
 * renderer 文档已被换掉(reload / 渲染进程崩溃)、新文档还没订阅授权请求的窗口。这段时间发过去的请求落在加载中
 * 的文档上:没有弹窗可见,main 的未决请求却占着槽等满无应答超时(2 分钟)再进超时冷却 —— 未决请求被 reload 取消后 agent 立即
 * 重试就会撞上,该窗口所有域被拒约 150s(审计实测时无应答超时为 5 分钟,约 330s)。期间的请求直接拒绝(requestAgentAuth);renderer 订阅建立后
 * 经 AGENT_AUTH_CHANNELS.READY 上报(markAgentAuthRendererReady)才恢复。
 */
const rendererNotReady = new Set<number>();

/**
 * 「文档被换掉」以**已提交**的导航为准(did-navigate:主框架、非同文档、已提交),不用 lib/wc-gone-hook 的
 * did-start-navigation:导航开始不等于文档会换 —— 被导航守卫在 will-navigate 里拦下、被中止、下载 / 204 响应的
 * 导航都只有「开始」没有「提交」,旧文档原样留着,不会再上报就绪。按「开始」置未就绪时,这样一次导航之后该窗口的
 * 授权请求被永久拒绝(直到下一次真正的 reload),显示中的弹窗也在 main 侧被提前取消(用户点了才发现应答无效)。
 * 导航开始到提交之间新文档同样收不到请求,由 rendererUnavailable 的 isLoadingMainFrame 覆盖。
 * (wc-gone-hook 的其它使用方回收的是「新文档会重新申请」的资源,宁早勿晚,语义不变。)
 */
export function watchAgentAuthRenderer(win: BrowserWindow): void {
  const wc = win.webContents;
  if (rendererGoneWatched.has(wc)) return;
  rendererGoneWatched.add(wc);
  const windowId = win.id;
  const onGone = (): void => {
    rendererNotReady.add(windowId);
    cancelAgentAuthByWindow(windowId);
  };
  // 文档换掉(提交导航 / 崩溃 / 主框架加载失败,-3 除外)的判定见 lib/renderer-document-gone(与深链、关窗 flush 共用)。
  onRendererDocumentGone(wc, onGone);
  // 窗口销毁:结算发往它的未决请求,之后不会再有请求发给它。
  wc.once('destroyed', () => {
    cancelAgentAuthByWindow(windowId);
    rendererNotReady.delete(windowId);
  });
}

/** renderer 上报授权请求的订阅已建立(AGENT_AUTH_CHANNELS.READY)。 */
export function markAgentAuthRendererReady(windowId: number): void {
  rendererNotReady.delete(windowId);
}

/** 目标窗口此刻显示不了授权弹窗:renderer 文档正在重建,或主框架仍在加载(首次加载 / 没被监听到的 reload)。 */
function rendererUnavailable(win: BrowserWindow): boolean {
  if (rendererNotReady.has(win.id)) return true;
  return win.webContents.isLoadingMainFrame();
}

/**
 * 显示不足该时长就到期的弹窗不记超时冷却 —— 用户没机会应答,也谈不上占屏。纵深:无应答超时现从开始显示起算,
 * 正常到期的都显示满 2 分钟;排队兜底上限按取消结算,本就不记。
 */
const MIN_SHOWN_FOR_TIMEOUT_COOLDOWN_MS = 5_000;

/**
 * 把该窗口最早的未决请求记为显示中(已记过则不动),并把它的计时从排队上限换成无应答超时。登记新请求、任一请求
 * 结算后调。
 */
function markDisplayed(windowId: number): void {
  for (const [requestId, entry] of pending) {
    if (entry.windowId !== windowId) continue;
    if (entry.shownAt === null) {
      entry.shownAt = Date.now();
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        if (pending.delete(requestId)) entry.settle('denied', 'timeout');
      }, PROMPT_TIMEOUT_MS);
    }
    return;
  }
}

const authSubject = (windowId: number, external: boolean): string =>
  `${windowId}:${external ? 'external' : 'window'}`;

function throttledError(admission: Exclude<PromptAdmission, { ok: true }>): Error {
  const seconds = Math.ceil(admission.retryAfterMs / 1000);
  const message =
    admission.reason === 'in-flight'
      ? 'another authorization prompt from this caller is already waiting for the user; wait for that decision before retrying'
      : admission.reason === 'rate'
        ? `too many authorization prompts; Continuo will not ask the user again for ${seconds}s`
        : `the user denied (or did not answer) a recent authorization prompt; Continuo will not ask again for ${seconds}s`;
  return codedError(ERROR_CODES.AGENT_NOT_AUTHORIZED, message);
}

/** 边界(E229):统计某窗口当前未决授权数。pending 已封顶后 O(≤MAX_PENDING_AUTH_GLOBAL)。 */
function pendingCountForWindow(windowId: number): number {
  let n = 0;
  for (const e of pending.values()) {
    if (e.windowId === windowId) n += 1;
  }
  return n;
}

export interface AgentAuthInfo {
  readonly method: string;
  readonly ownerWindowId?: number;
  /** 安全(F2):调用方是未绑定 Continuo 终端的外部客户端 → main 按独立的调用方类别记授权,弹窗标注来源。 */
  readonly external?: boolean;
}

/**
 * 选授权弹窗的目标窗口。
 * - 显式给了 ownerWindowId:只用该窗口;无效 / 已销毁 / 是 popout → null(fail-closed)。
 *   安全:此前回落到第一个主窗 —— 会话所属窗口已关(或是 popout)时,授权弹到用户正在用的另一个窗口,
 *   用户误以为是本窗口的 agent 而放行,或该窗口已「本次启动期间允许」→ 静默放行。popout 是 window.open
 *   子窗(未设 parent),没有可靠的「所属主窗」映射,且不挂授权弹窗,故一律拒绝。
 * - 未给 ownerWindowId → null(拒)。McpCallCtx.ownerWindowId 必填,此前「回落到第一个非 popout 主窗」
 *   是死代码,且一旦有无窗口上下文的调用方走到这里,授权会弹到用户正在用的任意窗口(同上误放行风险)。
 */
function pickAuthTargetWindow(ownerWindowId: number | undefined): BrowserWindow | null {
  if (ownerWindowId === undefined) return null;
  const target = BrowserWindow.fromId(ownerWindowId);
  if (!target || target.isDestroyed() || isPopoutUrl(target.webContents.getURL())) return null;
  return target;
}

/**
 * Tool 调用入口:把请求 push 给调用方窗口,等用户决定。
 * 目标窗口不存在 / 显示 2 分钟无应答超时 / 排队 10 分钟仍未显示 → 默认 'denied'(防卡死)。
 * 被节流(拒绝冷却 / 退避 / 超速 / 该调用方已有未决弹窗)→ 不弹窗,reject AGENT_NOT_AUTHORIZED(消息说明原因,
 * 工具门控原样抛给 agent)。目标窗口的 renderer 正在重新加载 → 同样 reject(消息说明稍后重试)。
 */
export async function requestAgentAuth(
  info: AgentAuthInfo,
): Promise<AgentAuthDecision> {
  const win = pickAuthTargetWindow(info.ownerWindowId);
  if (!win) return 'denied';
  // 边界(E229):全局 + per-window 未决授权双闸,超限直接终态 'denied'(不入 pending、不起 timer、
  // 不发 IPC),防外部 agent spam 让 pending/timer/IPC 线性放大。后备防线:已授权域的请求在下方直接放行、不入
  // pending,未授权请求受单飞约束(每调用方类别至多一个未决),正常与恶意并发都碰不到这个上限。
  if (
    pending.size >= MAX_PENDING_AUTH_GLOBAL ||
    pendingCountForWindow(win.id) >= MAX_PENDING_AUTH_PER_WINDOW
  ) {
    return 'denied';
  }
  const domain = agentAuthDomainOf(info.method);
  const subject = authSubject(win.id, info.external === true);
  const grantKey = `${subject}:${domain}`;
  watchAgentAuthRenderer(win);
  if (rendererUnavailable(win)) {
    throttle.noteAttempt(subject);
    throw codedError(
      ERROR_CODES.AGENT_NOT_AUTHORIZED,
      'the Continuo window is reloading and cannot show an authorization prompt yet; retry in a few seconds',
    );
  }
  // 该域已「本次启动期间允许」→ 直接放行(不发 IPC、不弹窗、不走节流)。
  if (sessionGrants.has(grantKey)) return 'session';
  const admission = throttle.admit(subject, [domain]);
  if (!admission.ok) throw throttledError(admission);
  const requestId = `req-${crypto.randomUUID()}`;
  return new Promise<AgentAuthDecision>((resolve) => {
    const settle = (decision: AgentAuthDecision, cause: SettleCause): void => {
      clearTimeout(entry.timer);
      const granted = cause === 'answer' && decision === 'session';
      throttle.endPrompt(subject);
      if (cause === 'answer') {
        throttle.noteDecision(subject, [domain], decision === 'denied' ? 'deny' : 'grant');
      } else if (
        cause === 'timeout' &&
        entry.shownAt !== null &&
        Date.now() - entry.shownAt >= MIN_SHOWN_FOR_TIMEOUT_COOLDOWN_MS
      ) {
        throttle.noteTimeout(subject);
      }
      // 非应答结算(超时 / 排队兜底 / 取消):通知该窗口撤掉对应弹窗(renderer 不自行计时)。窗口已销毁 / 发送失败
      // 无弹窗可撤,忽略。撤销路径另有 REVOKED 广播,重复通知在 renderer 侧找不到槽即 no-op。
      if (cause === 'timeout' || cause === 'cancelled') {
        try {
          if (!win.isDestroyed()) win.webContents.send(AGENT_AUTH_CHANNELS.CANCELLED, { requestId });
        } catch {
          // 发送时窗口恰好销毁
        }
      }
      // 调用方都是先从 pending 删除再 settle → 此刻窗口内最早的未决请求即 renderer 接着显示的那个。
      markDisplayed(win.id);
      if (granted) sessionGrants.add(grantKey);
      resolve(decision);
    };
    // 排队兜底:一直没轮到显示 → 按取消结算(不计拒绝、不进冷却)。轮到显示时 markDisplayed 换成无应答超时。
    const queueTimer = setTimeout(() => {
      if (pending.delete(requestId)) settle('denied', 'cancelled');
    }, QUEUE_MAX_MS);
    const entry: PendingAuth = { windowId: win.id, shownAt: null, timer: queueTimer, settle };
    pending.set(requestId, entry);
    markDisplayed(win.id);
    const payload: AgentAuthRequestPayload = {
      requestId,
      method: info.method,
      ...(info.external === true ? { external: true } : {}),
    };
    // race(R62):pending.set 在前、send 在后。若 win 通过了上面的 isDestroyed 检查,但其
    // webContents 在此刻已销毁(窗口正在关闭的竞态窗口),send 会同步抛("Object has been
    // destroyed")。不捕获则 Promise executor 抛错使 Promise reject(契约要求失败返 'denied'
    // 而非抛),且已登记的 pending 条目 + timer 会泄漏到无应答超时才清 —— 期间发起请求的、
    // 仍存活的外部 agent 进程干等假死。投递失败立即清 pending + timer 并 resolve('denied'),
    // 与 plugin-mcp send-fail-abort 同族(那条已修,这是未传播的兄弟入口)。
    try {
      win.webContents.send(AGENT_AUTH_CHANNELS.REQUEST, payload);
    } catch {
      if (pending.delete(requestId)) settle('denied', 'cancelled');
    }
  });
}

/**
 * 解析 pending Promise。不存在的 requestId(已超时 / 重复 / 已撤销)→ no-op,返回 false。
 */
export function resolveAgentAuthRequest(
  requestId: string,
  decision: AgentAuthDecision,
): boolean {
  const r = pending.get(requestId);
  if (!r) return false;
  pending.delete(requestId);
  r.settle(decision, 'answer');
  return true;
}

/**
 * IPC handler 回调:renderer 应答时调。requestId 已不在等待(撤销 / 超时 / 窗口关闭已结算并删除)→
 * 抛 AGENT_AUTH_REQUEST_NOT_PENDING(renderer 收到 ok:false):main 不记授权(sessionGrants 只在应答结算时写入),
 * renderer 也据此不在界面副本里记该次「本次启动期间允许」。
 */
export function answerAgentAuthRequest(
  requestId: string,
  decision: AgentAuthDecision,
  senderWindowId: number | null,
): void {
  // 安全:应答方须是收到该请求的窗口(IPC sender 所在窗口)。否则别的窗口 / 拿到 raw IPC 的调用方截到
  // requestId 即可替目标窗口放行。不匹配按「不在等待」拒绝,且不结算(目标窗口仍可正常应答)。
  const entry = pending.get(requestId);
  if (!entry || entry.windowId !== senderWindowId) {
    throw codedError(
      ERROR_CODES.AGENT_AUTH_REQUEST_NOT_PENDING,
      'agent auth request is no longer pending',
    );
  }
  resolveAgentAuthRequest(requestId, decision);
}

/**
 * 目标窗口关闭/销毁,或其 renderer 文档被换掉(reload / 渲染进程崩溃,见 watchAgentAuthRenderer)→ 把发往它的所有
 * pending 授权请求立即结算为 denied(按取消:不计拒绝、不进冷却),并清掉它的授权。
 * 否则发起的**外部 agent CLI 进程**(仍存活)要干等满 PROMPT_TIMEOUT_MS(2 分钟)才收到
 * 默认拒绝,表现为 agent 假死。这与 request-scope「等待者是已死请求方自己」不同 ——
 * 这里等待者是活的外部进程。镜像 stop-hook broker.cancelByWindow(审计 #3)。返回取消数。
 * 见第十七轮 P2-AT。
 */
export function cancelAgentAuthByWindow(windowId: number): number {
  let count = 0;
  for (const [requestId, entry] of [...pending]) {
    if (entry.windowId !== windowId) continue;
    pending.delete(requestId);
    entry.settle('denied', 'cancelled');
    count += 1;
  }
  // renderer 文档没了 → 它的授权态也没了。
  for (const key of sessionGrants) {
    if (key.startsWith(`${windowId}:`)) sessionGrants.delete(key);
  }
  return count;
}

/**
 * 退出清理:把所有窗口的 pending 授权请求立即结算为 denied。before-quit 时窗口已隐藏、无人应答弹窗,
 * 挂在授权上的 MCP 工具调用否则等满无应答超时定时器,拖住 mcpHost.close() → 应用不可见且无法退出。
 * 不发 IPC、不走 revokeAndKillAgentSessions:这不是「撤销」,不应重置 renderer 的会话授权或轮换 token。
 * 返回取消数。
 */
export function cancelAllAgentAuth(): number {
  const entries = [...pending.values()];
  pending.clear();
  for (const entry of entries) entry.settle('denied', 'bulk-cancelled');
  return entries.length;
}

export interface AgentAuthControllerTeardown {
  readonly listControllerTokens: () => readonly string[];
  readonly killByController: (controllerToken: string, reason: string) => void;
}

let controllerTeardown: AgentAuthControllerTeardown | null = null;

/**
 * main/index.ts 注入 debug teardown 钩子。agent-auth 不能直接 import DebugService,
 * 否则会把授权 transport 与 debug runtime 绑成循环依赖。
 */
export function setAgentAuthControllerTeardown(
  teardown: AgentAuthControllerTeardown | null,
): void {
  controllerTeardown = teardown;
}

/** 测试用:清空所有 pending(test 隔离). */
export function _resetPendingForTest(): void {
  for (const [, r] of pending) r.settle('denied', 'bulk-cancelled');
  pending.clear();
  throttle = newAuthThrottle();
  sessionGrants.clear();
  rendererNotReady.clear();
  controllerTeardown = null;
}

// 边界(E229)测试用:未决授权上限常量。
export const MAX_PENDING_AUTH_GLOBAL_FOR_TEST = MAX_PENDING_AUTH_GLOBAL;
export const MAX_PENDING_AUTH_PER_WINDOW_FOR_TEST = MAX_PENDING_AUTH_PER_WINDOW;

// ── revoke(状态栏"终止全部 agent terminal"按钮触发)─────────────

let mcpHostRef: McpHost | null = null;

/** main/index.ts 启动 host 后调,把 host 引用注入,供 revoke 用. */
export function setMcpHostRef(host: McpHost | null): void {
  mcpHostRef = host;
}

export interface RevokeResult {
  /** 被终止的 agent session 数(originHint='agent'). */
  readonly killed: number;
  /** 是否成功 rotate token(无 mcpHost 时 false). */
  readonly rotated: boolean;
}

/**
 * 撤销 session 授权:
 *  1. rotate MCP token(已运行的 agent CLI 持的旧 token 立刻 401)
 *  2. 终止所有 originHint='agent' 的 PTY + 删 metadata
 *
 * 不动 originHint='user' 的 session;不重启 mcp host。
 * 「本次启动期间允许」在此清空(权威在 main);各窗口 renderer 的界面副本经 REVOKED 广播重置。
 */
export function revokeAndKillAgentSessions(): RevokeResult {
  // race(R91,安全):撤销时同步把所有 pending 授权请求结算为 denied 并清空。否则撤销前卡在授权
  // 等待中的请求,若随后收到 renderer **迟到的** respond('session'),resolveAgentAuthRequest 仍会
  // 按旧 requestId 放行 → 撤销后那次 MCP tool call 仍执行一次,违反「撤销即时生效」的安全边界。
  // 清空 pending 后,迟到 respond 找不到条目 → no-op,无法复活已撤销的授权。
  cancelAllAgentAuth();
  // 清空全部「本次启动期间允许」(权威在此;各窗口的界面副本随下方 REVOKED 广播清空)。拒绝冷却不清。
  sessionGrants.clear();
  let rotated = false;
  if (mcpHostRef) {
    mcpHostRef.rotateToken();
    rotated = true;
  }
  // 在途 create_session(授权已过、PTY 尚未登记)不在下方快照里:取消后由创建流程自行回收、不跑 autorun。
  cancelAgentTerminalCreates();
  let killed = 0;
  // terminalSessions.getAll() 已返回快照数组;remove 改 Map 不影响本轮遍历。
  const snapshot = terminalSessions.getAll();
  for (const s of snapshot) {
    if (s.originHint !== 'agent') continue;
    // 用户**显式撤销** agent 授权是安全动作:force(立即 SIGKILL)而非 Ctrl+C + 3s grace。否则吞 SIGINT /
    // 正在跑破坏性命令的 agent 子进程在撤销后还能继续运行最长 3s。token 已 rotate 挡住新 MCP 调用,但已在跑的
    // 本地子进程不受 token 影响,必须立即强杀。
    discardTerminalSession({ sessionStore: terminalSessions, service: termService }, s.id, { force: true });
    killed += 1;
  }
  // debug 会话与在途 launch 按调用方回收(listControllerTokens 已含全部已登记会话与在途 launch 的调用方;
  // 只有终端、没有 debug 资源的调用方无可回收)。
  if (controllerTeardown) {
    for (const token of controllerTeardown.listControllerTokens()) {
      controllerTeardown.killByController(token, 'revoked');
    }
  }
  // 跨窗口撤销:授权已在上方清空(放行权威在 main);各窗口 renderer 的界面副本与残留弹窗由广播统一重置
  //(否则其它窗口仍显示撤销入口;残留弹窗对应的请求已结算,不撤掉的话用户点了只会得到 NOT_PENDING)。
  broadcastToWindows(AGENT_AUTH_CHANNELS.REVOKED, () => ({}), '[agent-auth] REVOKED');
  return { killed, rotated };
}
