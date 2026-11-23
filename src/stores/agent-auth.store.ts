// Agent Terminal MCP — 授权 store(Phase 2)。
// 真相源:renderer 单一 store。main 端通过反向 IPC 调 ensure(),由 renderer
// 决策(已 sessionGranted 直接通过,否则弹窗)。
//
// 决策(2026-05-05):
//   - 一次性授权(本次启动有效),不持久化
//   - 撤销走"终止全部 agent terminal"按钮 → revoke()
//   - 同一时刻只显示一个弹窗;窗口内 agent / external 客户端各占一个槽(同类并发第二条立即 denied,异类排队)
//
// BDD: src/__tests__/agent-terminal-mcp-auth/

import { create } from 'zustand';
import {
  AGENT_AUTH_PROMPT_TIMEOUT_MS,
  agentAuthDomainOf,
} from '../../electron/shared/agent-auth-channels';

export type AuthDecision = 'once' | 'session' | 'denied';
/**
 * ensure 的结果:用户决定,或 'cancelled' —— main 已撤销并结算了该请求(本地仅取消弹窗),
 * 应答方不得再向 main respond(main 已无该 pending,会返回 NOT_PENDING)。
 */
export type EnsureOutcome = AuthDecision | 'cancelled';

export interface PendingAuthRequest {
  readonly requestId: string;
  readonly method: string;
  /** 来自未绑定 Continuo 终端的外部客户端(弹窗标注来源)。 */
  readonly external?: boolean;
}

interface EnsureInfo {
  readonly method: string;
  /** 安全(F2):外部客户端请求 → 只读写 external 授权状态,不用窗口级授权。 */
  readonly external?: boolean;
}

type AgentAuthState = {
  pending: PendingAuthRequest | null;
  /** 终端域的「本次启动期间允许」。 */
  sessionGranted: boolean;
  /** debug 域的「本次启动期间允许」(与终端域互不放行)。 */
  debugSessionGranted: boolean;
  /** 插件工具域(method 以 plugin. 开头)的「本次启动期间允许」(与终端 / debug 域互不放行)。 */
  pluginSessionGranted: boolean;
  /**
   * 安全(F2):外部客户端(stdio 未发 hello,未绑定 Continuo 终端)的「本次启动期间允许」,分终端 / debug 两个域。
   * 与上面的窗口级授权互不放行:外部请求不读也不写窗口级标志,窗口请求也不读 external 标志。
   * 插件工具域无 external 标志:main plugin-mcp-bridge 在授权前即拒绝外部客户端调用插件工具。
   */
  externalSessionGranted: boolean;
  externalDebugSessionGranted: boolean;

  ensure(info: EnsureInfo): Promise<EnsureOutcome>;
  /** 'session' 只结算当前请求;域授权须待 main 确认后经 confirmSessionGrant 生效。 */
  grant(kind: 'once' | 'session'): void;
  /**
   * main 确认 'session' 应答已生效(respond ok)后调:给 method 所属域记「本次启动期间允许」。
   * epoch 须为结算时 getAgentAuthEpoch() 的值;期间发生过 revoke → 忽略(不复活已撤销授权)。
   */
  confirmSessionGrant(method: string, epoch: number, external?: boolean): void;
  deny(): void;
  revoke(): void;
  /**
   * main 已撤销(本窗口撤销 IPC 成功 / 其它窗口撤销的 REVOKED 广播):与 revoke() 同样重置
   * (epoch+1、清所有域的 session 授权),并把残留弹窗以 'cancelled' 结算(main 已按 denied 结算并删除)。
   */
  applyMainRevoked(): void;
};

/**
 * 授权分 3 个域 × 2 类调用方:
 * - 域:method 以 `debug.` 开头的属 debug 域,以 `plugin.` 开头的属插件工具域,其余(终端工具及未知 method)属终端域。
 *   debug 能启动进程、读变量、执行表达式,与终端控制是不同的授权面;共用一个标志位时,用户对终端点了
 *   「本次启动期间允许」后 debug 工具会被静默放行。插件工具域同理(见 isPluginAuthMethod)。
 * - 调用方:窗口级(绑定 Continuo 终端的 agent)与外部客户端(stdio 未发 hello)各自记授权、互不放行。
 *   外部客户端没有插件工具域(main 在授权前即拒绝),所以实际共 5 个标志位(见 SESSION_GRANT_KEYS)。
 */
export function isDebugAuthMethod(method: string): boolean {
  return agentAuthDomainOf(method) === 'debug';
}

/**
 * 插件注册的 MCP 工具(main plugin-mcp-bridge 以 `plugin.<tool 名>` 请求)属第三个独立域:插件工具可做
 * 任意插件能力(如 git stage/commit),不应被终端 / debug 域的授权静默放行。
 */
export function isPluginAuthMethod(method: string): boolean {
  return agentAuthDomainOf(method) === 'plugin';
}

/**
 * 窗口级(绑定 Continuo 终端的 agent)「本次启动期间允许」标志位。撤销 IPC 失败回滚时只恢复这些。
 */
export const WINDOW_SESSION_GRANT_KEYS = [
  'sessionGranted',
  'debugSessionGranted',
  'pluginSessionGranted',
] as const;
/** 外部客户端的「本次启动期间允许」标志位。撤销失败时不恢复(往拒绝方向)。 */
export const EXTERNAL_SESSION_GRANT_KEYS = [
  'externalSessionGranted',
  'externalDebugSessionGranted',
] as const;
/** 全部「本次启动期间允许」标志位的单一来源:撤销 / 撤销入口可见性 / 测试重置都从这里取。 */
export const SESSION_GRANT_KEYS = [
  ...WINDOW_SESSION_GRANT_KEYS,
  ...EXTERNAL_SESSION_GRANT_KEYS,
] as const;

export type SessionGrantKey = (typeof SESSION_GRANT_KEYS)[number];

/** 任一域(含外部客户端)存在「本次启动期间允许」→ 需要提供撤销入口。 */
export function hasAnySessionGrant(s: Readonly<Record<SessionGrantKey, boolean>>): boolean {
  return SESSION_GRANT_KEYS.some((k) => s[k]);
}

const NO_SESSION_GRANTS = Object.fromEntries(
  SESSION_GRANT_KEYS.map((k) => [k, false]),
) as Record<SessionGrantKey, false>;

/**
 * (method, 调用方类别) → 所属「本次启动期间允许」标志位。null = 该组合不允许授权(外部客户端调插件工具:
 * main 已在授权前拒绝,此处纵深再拒,不弹窗也不记授权)。
 */
function grantKeyFor(method: string, external?: boolean): SessionGrantKey | null {
  if (external === true) {
    if (isDebugAuthMethod(method)) return 'externalDebugSessionGranted';
    if (isPluginAuthMethod(method)) return null;
    return 'externalSessionGranted';
  }
  if (isDebugAuthMethod(method)) return 'debugSessionGranted';
  if (isPluginAuthMethod(method)) return 'pluginSessionGranted';
  return 'sessionGranted';
}

// 撤销代际:每次 revoke +1。'session' 应答在 IPC 往返期间若被 revoke,迟到的确认不得把授权记回。
let authEpoch = 0;
export function getAgentAuthEpoch(): number {
  return authEpoch;
}

// 内部:占着槽的授权请求(zustand 状态外存,避免序列化函数)。slots[0] 即显示中的弹窗(state.pending),其余排队。
// 安全:按调用方类别(窗口内 agent / external 客户端)各一个槽。此前全局只有一个 pending:external 调用方
// (未 hello 的 stdio 客户端,可以是别的窗口里的 agent)连弹即可占住主窗唯一的槽,窗口内合法 agent 的首次授权
// 被自动拒绝。不同类别的请求排在后面等显示(同一时刻仍只显示一个弹窗,不堆叠);同类别已占槽 → 立即拒。
//
// race(R88):每个请求带与 main 端 agent-auth.service PROMPT_TIMEOUT_MS 对齐的本地超时。main 在超时(2 分钟)后把该
// 请求 resolve 为 denied(外部 agent 已收到拒绝),但不通知 renderer。若 renderer 不同 TTL 清理,授权弹窗永久滞留并
// 占着槽,直到用户手动点掉这个已失效的旧弹窗。
// 两侧都从请求**开始显示**(成为 slots[0])起算:此前从到达起算,排在后面的请求轮到显示时已经到期(external 只发起
// 不应答、占住显示时,窗口内合法 agent 的请求显示 0 秒即被拒)。排队中的请求不计时:每类调用方只占一个槽,排在前面
// 的至多显示 2 分钟;main 侧另有排队兜底上限(AGENT_AUTH_QUEUE_MAX_MS),renderer 的队列碰不到。
const PROMPT_TIMEOUT_MS = AGENT_AUTH_PROMPT_TIMEOUT_MS;
interface AuthSlot {
  readonly req: PendingAuthRequest;
  readonly resolve: (outcome: EnsureOutcome) => void;
  /** 显示中才有:无应答超时。 */
  timer?: ReturnType<typeof setTimeout>;
}
const slots: AuthSlot[] = [];

function generateRequestId(): string {
  // crypto.randomUUID 在 Node 与浏览器 modern env 都可用。
  // 兜底 Math.random(测试 / jsdom):非关键,只要不撞同次会话 pending。
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const useAgentAuthStore = create<AgentAuthState>((set, get) => ({
  pending: null,
  ...NO_SESSION_GRANTS,

  ensure(info) {
    const key = grantKeyFor(info.method, info.external);
    // 纵深:不允许授权的组合(外部客户端调插件工具)直接拒,不弹窗。
    if (key === null) return Promise.resolve('denied' as const);
    // 该请求所属域(按调用方类别区分窗口 / external)已 session 授权 → 直接通过,不设 pending(支持并发)
    if (get()[key]) {
      return Promise.resolve('session' as const);
    }
    // 同类别调用方已占槽(显示中或排队中)→ 立即拒(简化并发,与 plugin permission-prompt 同型)
    const external = info.external === true;
    if (slots.some((slot) => (slot.req.external === true) === external)) {
      return Promise.resolve('denied' as const);
    }
    const req: PendingAuthRequest = {
      requestId: generateRequestId(),
      method: info.method,
      ...(external ? { external: true } : {}),
    };
    return new Promise<EnsureOutcome>((resolve) => {
      slots.push({ req, resolve });
      syncPending();
    });
  },

  grant(kind) {
    // 安全:'session' 此处**不**记域授权。该请求在 main 可能已被撤销 / 超时删除(旧弹窗仍显示),
    // 若此刻置 sessionGranted,之后的请求会被静默放行。由应答方在 main 确认后调 confirmSessionGrant。
    settleDisplayed(kind);
  },

  confirmSessionGrant(method, epoch, external) {
    if (epoch !== authEpoch) return;
    // 只给该请求所属的域(及调用方类别)记 session 授权。
    const key = grantKeyFor(method, external);
    if (key !== null && !get()[key]) set({ [key]: true });
  },

  deny() {
    settleDisplayed('denied');
  },

  revoke() {
    authEpoch += 1;
    set((s) => (hasAnySessionGrant(s) ? NO_SESSION_GRANTS : s));
  },

  applyMainRevoked() {
    get().revoke();
    for (const slot of slots.splice(0)) {
      clearTimeout(slot.timer);
      slot.resolve('cancelled');
    }
    syncPending();
  },
}));

/** state.pending 跟随 slots[0](显示中的弹窗);新成为显示中的开始计无应答超时。 */
function syncPending(): void {
  const head = slots[0];
  if (head && head.timer === undefined) {
    const { requestId } = head.req;
    // 过期 → 以 'cancelled' 收口(main 已 denied 并删除该请求):调用方不再 respond(否则 main 返回
    // NOT_PENDING → 误导性「授权响应失败」toast)。
    head.timer = setTimeout(() => settleSlot(requestId, 'cancelled'), PROMPT_TIMEOUT_MS);
  }
  const next = head?.req ?? null;
  if (useAgentAuthStore.getState().pending !== next) useAgentAuthStore.setState({ pending: next });
}

function settleSlot(requestId: string, outcome: EnsureOutcome): void {
  const index = slots.findIndex((slot) => slot.req.requestId === requestId);
  if (index < 0) return;
  const [slot] = slots.splice(index, 1);
  clearTimeout(slot!.timer);
  syncPending();
  slot!.resolve(outcome);
}

/** 用户对显示中弹窗的决定。 */
function settleDisplayed(outcome: AuthDecision): void {
  const displayed = slots[0];
  if (displayed) settleSlot(displayed.req.requestId, outcome);
  else syncPending();
}

/** 测试用:重置内部状态(状态 + 挂起 resolver). */
export function _resetAgentAuthForTest(): void {
  for (const slot of slots.splice(0)) clearTimeout(slot.timer);
  useAgentAuthStore.setState({
    pending: null,
    ...NO_SESSION_GRANTS,
  });
}
