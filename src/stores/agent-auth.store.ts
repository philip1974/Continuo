// Agent Terminal MCP — 授权 store(Phase 2)。
// 真相源:renderer 单一 store。main 端通过反向 IPC 调 ensure(),由 renderer
// 决策(已 sessionGranted 直接通过,否则弹窗)。
//
// 决策(2026-05-05):
//   - 一次性授权(本次启动有效),不持久化
//   - 撤销走"终止全部 agent terminal"按钮 → revoke()
//   - 同一时刻只允许一个 pending(并发 ensure 第二条立即 denied)
//
// BDD: src/__tests__/agent-terminal-mcp-auth/

import { create } from 'zustand';
import {
  AGENT_AUTH_PLUGIN_METHOD_PREFIX,
  AGENT_AUTH_PROMPT_TIMEOUT_MS,
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
  readonly agentLabel?: string;
  /** 来自未绑定 Continuo 终端的外部客户端(弹窗标注来源)。 */
  readonly external?: boolean;
}

interface EnsureInfo {
  readonly method: string;
  readonly agentLabel?: string;
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
 * 授权分两个域:method 以 `debug.` 开头的属 debug 域,其余(终端工具及未知 method)属终端域。
 * debug 能启动进程、读变量、执行表达式,与终端控制是不同的授权面;共用一个标志位时,用户对终端点了
 * 「本次启动期间允许」后 debug 工具会被静默放行。
 */
export function isDebugAuthMethod(method: string): boolean {
  return method.startsWith('debug.');
}

/**
 * 插件注册的 MCP 工具(main plugin-mcp-bridge 以 `plugin.<tool 名>` 请求)属第三个独立域:插件工具可做
 * 任意插件能力(如 git stage/commit),不应被终端 / debug 域的授权静默放行。
 */
export function isPluginAuthMethod(method: string): boolean {
  return method.startsWith(AGENT_AUTH_PLUGIN_METHOD_PREFIX);
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

// 内部:挂起 Promise 的 resolver(zustand 状态外存,避免序列化函数)。
let pendingResolver: ((outcome: EnsureOutcome) => void) | null = null;

// race(R88):与 main 端 agent-auth.service PROMPT_TIMEOUT_MS 对齐的 renderer 本地超时。main 在
// 5min 后把该请求 resolve 为 denied(外部 agent 已收到拒绝),但不通知 renderer。若 renderer 不
// 同 TTL 清理,授权弹窗(pending/Modal)永久滞留,且 pending!==null 让后续 agent auth 请求被
// 立即拒,直到用户手动点掉这个已失效的旧弹窗。本地超时到点 → deny + 清 pending(与 main 一致)。
const PROMPT_TIMEOUT_MS = AGENT_AUTH_PROMPT_TIMEOUT_MS;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
function clearPendingTimer(): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

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
    // 已有 pending → 第二条立即拒(简化并发,与 plugin permission-prompt 同型)
    if (get().pending !== null) {
      return Promise.resolve('denied' as const);
    }
    const req: PendingAuthRequest = {
      requestId: generateRequestId(),
      method: info.method,
      ...(info.agentLabel !== undefined ? { agentLabel: info.agentLabel } : {}),
      ...(info.external === true ? { external: true } : {}),
    };
    set({ pending: req });
    return new Promise<EnsureOutcome>((resolve) => {
      pendingResolver = resolve;
      // race(R88):同 TTL 本地超时。过期且仍是本请求 → 清 pending(main 已 denied 并删除该请求),
      // 避免失效弹窗滞留 + 阻塞后续请求。结算为 'cancelled':调用方不再 respond(否则 main 返回
      // NOT_PENDING → 误导性「授权响应失败」toast)。grant/deny/reset 都会 clearPendingTimer 防误触。
      clearPendingTimer();
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (get().pending?.requestId !== req.requestId) return;
        const r = pendingResolver;
        pendingResolver = null;
        set({ pending: null });
        r?.('cancelled');
      }, PROMPT_TIMEOUT_MS);
    });
  },

  grant(kind) {
    clearPendingTimer();
    const resolver = pendingResolver;
    pendingResolver = null;
    if (!resolver && get().pending === null) return;
    // 安全:'session' 此处**不**记域授权。该请求在 main 可能已被撤销 / 超时删除(旧弹窗仍显示),
    // 若此刻置 sessionGranted,之后的请求会被静默放行。由应答方在 main 确认后调 confirmSessionGrant。
    set({ pending: null });
    resolver?.(kind);
  },

  confirmSessionGrant(method, epoch, external) {
    if (epoch !== authEpoch) return;
    // 只给该请求所属的域(及调用方类别)记 session 授权。
    const key = grantKeyFor(method, external);
    if (key !== null && !get()[key]) set({ [key]: true });
  },

  deny() {
    clearPendingTimer();
    const resolver = pendingResolver;
    pendingResolver = null;
    if (!resolver && get().pending === null) return;
    set({ pending: null });
    resolver?.('denied');
  },

  revoke() {
    authEpoch += 1;
    set((s) => (hasAnySessionGrant(s) ? NO_SESSION_GRANTS : s));
  },

  applyMainRevoked() {
    get().revoke();
    clearPendingTimer();
    const resolver = pendingResolver;
    pendingResolver = null;
    if (get().pending !== null) set({ pending: null });
    resolver?.('cancelled');
  },
}));

/** 测试用:重置内部状态(状态 + 挂起 resolver). */
export function _resetAgentAuthForTest(): void {
  clearPendingTimer();
  pendingResolver = null;
  useAgentAuthStore.setState({
    pending: null,
    ...NO_SESSION_GRANTS,
  });
}
