// Agent Terminal MCP — 授权服务(main 进程,P2)。
// 反向 IPC 调度器:tool 调 requestAgentAuth → push 给 renderer →
// 等 renderer 通过 IPC respond 回 → resolve 挂起的 Promise。
//
// 真相源在 renderer(`src/stores/agent-auth.store.ts`),main 端只是 transport。
// renderer 端的 store.ensure 处理 sessionGranted / 并发 pending 等状态机。

import * as crypto from 'node:crypto';
import { BrowserWindow } from 'electron';
import {
  AGENT_AUTH_CHANNELS,
  type AgentAuthDecision,
  type AgentAuthRequestPayload,
} from '../../shared/agent-auth-channels';
import * as terminalSessions from './terminal-sessions.service';
import * as termService from './terminal.service';
import type { McpHost } from './mcp-host.service';
import { isPopoutUrl } from '../popout-url';
import { pickMainWindowPreferNonPopout } from './main-window-picker.service';

// 5 分钟无应答 → 默认拒绝(防 renderer 卡死时 tool Promise 永远悬挂)
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

// 边界(E229,E227/E228 pending 数量上限族):未决授权请求数量上限。requestAgentAuth 每次登记一条
// pending + 起 5min timer + 向 renderer 发 IPC;此前无数量上限 —— 外部 MCP/agent 可并发 spam 大量
// 需授权的 tool 调用,renderer 同一时间只弹一个,其余全堆在 main 等满 5min 超时 → pending Map + timer +
// IPC 线性放大内存/事件循环,发起的外部 agent 进程干等假死。全局 + per-window 双闸(对齐 E227
// ScopeRequestCorrelator),超限直接终态 'denied'(不入 pending、不起 timer、不发 IPC)。backstop 值远超
// 任何正常并发授权(renderer store.ensure 仍处理合法并发 pending,见文件头注释),只挡 spam。
const MAX_PENDING_AUTH_GLOBAL = 256; // 全局未决授权上限
const MAX_PENDING_AUTH_PER_WINDOW = 64; // 单窗口未决授权上限

interface PendingAuth {
  /** 弹窗目标窗口 id(target 或 pickMainWindow 兜底)。窗口关闭即按它结算。 */
  readonly windowId: number;
  readonly settle: (decision: AgentAuthDecision) => void;
}
const pending = new Map<string, PendingAuth>();

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
  readonly agentLabel?: string;
  readonly ownerWindowId?: number;
}

/**
 * Tool 调用入口:把请求 push 给主窗,等用户决定。
 * 主窗不存在 / 5 分钟超时 → 默认 'denied'(防卡死)。
 */
export async function requestAgentAuth(
  info: AgentAuthInfo,
): Promise<AgentAuthDecision> {
  const targetWin =
    info.ownerWindowId !== undefined
      ? BrowserWindow.fromId(info.ownerWindowId)
      : null;
  const win =
    targetWin &&
    !targetWin.isDestroyed() &&
    !isPopoutUrl(targetWin.webContents.getURL())
      ? targetWin
      : pickMainWindowPreferNonPopout();
  if (!win) return 'denied';
  // 边界(E229):全局 + per-window 未决授权双闸,超限直接终态 'denied'(不入 pending、不起 timer、
  // 不发 IPC),防外部 agent spam 让 pending/timer/IPC 线性放大。renderer 合法并发由 store.ensure 处理,
  // 此 backstop 远高于正常并发量,只挡恶意 spam。
  if (
    pending.size >= MAX_PENDING_AUTH_GLOBAL ||
    pendingCountForWindow(win.id) >= MAX_PENDING_AUTH_PER_WINDOW
  ) {
    return 'denied';
  }
  const requestId = `req-${crypto.randomUUID()}`;
  return new Promise<AgentAuthDecision>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        resolve('denied');
      }
    }, PROMPT_TIMEOUT_MS);
    pending.set(requestId, {
      windowId: win.id,
      settle: (decision) => {
        clearTimeout(timer);
        resolve(decision);
      },
    });
    const payload: AgentAuthRequestPayload = {
      requestId,
      method: info.method,
      ...(info.agentLabel !== undefined ? { agentLabel: info.agentLabel } : {}),
    };
    // race(R62):pending.set 在前、send 在后。若 win 通过了上面的 isDestroyed 检查,但其
    // webContents 在此刻已销毁(窗口正在关闭的竞态窗口),send 会同步抛("Object has been
    // destroyed")。不捕获则 Promise executor 抛错使 Promise reject(契约要求失败返 'denied'
    // 而非抛),且已登记的 pending 条目 + timer 会泄漏到 5min 超时才清 —— 期间发起请求的、
    // 仍存活的外部 agent 进程干等假死。投递失败立即清 pending + timer 并 resolve('denied'),
    // 与 plugin-mcp send-fail-abort 同族(那条已修,这是未传播的兄弟入口)。
    try {
      win.webContents.send(AGENT_AUTH_CHANNELS.REQUEST, payload);
    } catch {
      if (pending.has(requestId)) {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve('denied');
      }
    }
  });
}

/**
 * IPC handler 回调:renderer 应答时调,解析 pending Promise。
 * 不存在的 requestId(已超时 / 重复)→ no-op。
 */
export function resolveAgentAuthRequest(
  requestId: string,
  decision: AgentAuthDecision,
): void {
  const r = pending.get(requestId);
  if (!r) return;
  pending.delete(requestId);
  r.settle(decision);
}

/**
 * 目标窗口关闭/销毁 → 把发往它的所有 pending 授权请求立即结算为 denied。
 * 否则发起的**外部 agent CLI 进程**(仍存活)要干等满 PROMPT_TIMEOUT_MS(5min)才收到
 * 默认拒绝,表现为 agent 假死。这与 request-scope「等待者是已死请求方自己」不同 ——
 * 这里等待者是活的外部进程。镜像 stop-hook broker.cancelByWindow(审计 #3)。返回取消数。
 * 见第十七轮 P2-AT。
 */
export function cancelAgentAuthByWindow(windowId: number): number {
  let count = 0;
  for (const [requestId, entry] of [...pending]) {
    if (entry.windowId !== windowId) continue;
    pending.delete(requestId);
    entry.settle('denied');
    count += 1;
  }
  return count;
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
  for (const [, r] of pending) r.settle('denied');
  pending.clear();
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
 * 调用方(renderer)还需要本地调 useAgentAuthStore.revoke() 把 sessionGranted=false,
 * 这部分本服务不包(避免循环依赖)。
 */
export function revokeAndKillAgentSessions(): RevokeResult {
  // race(R91,安全):撤销时同步把所有 pending 授权请求结算为 denied 并清空。否则撤销前卡在授权
  // 等待中的请求,若随后收到 renderer **迟到的** respond('session'),resolveAgentAuthRequest 仍会
  // 按旧 requestId 放行 → 撤销后那次 MCP tool call 仍执行一次,违反「撤销即时生效」的安全边界。
  // 清空 pending 后,迟到 respond 找不到条目 → no-op,无法复活已撤销的授权。
  for (const [requestId, entry] of [...pending]) {
    pending.delete(requestId);
    entry.settle('denied');
  }
  let rotated = false;
  if (mcpHostRef) {
    mcpHostRef.rotateToken();
    rotated = true;
  }
  let killed = 0;
  const controllerTokens = new Set<string>();
  if (controllerTeardown) {
    for (const token of controllerTeardown.listControllerTokens()) {
      if (typeof token === 'string' && token.length > 0) controllerTokens.add(token);
    }
  }
  // terminalSessions.getAll() 已返回快照数组;remove 改 Map 不影响本轮遍历。
  const snapshot = terminalSessions.getAll();
  for (const s of snapshot) {
    if (s.originHint !== 'agent') continue;
    if (typeof s.controllerToken === 'string' && s.controllerToken.length > 0) {
      controllerTokens.add(s.controllerToken);
    }
    terminalSessions.remove(s.id);
    // 用户**显式撤销** agent 授权是安全动作:用 forceKill(立即 SIGKILL)而非
    // kill()(先 Ctrl+C、3s grace 后才 SIGKILL)。否则吞 SIGINT / 正在跑破坏性
    // 命令的 agent 子进程在撤销后还能继续运行最长 3s。token 已 rotate 挡住新
    // MCP 调用,但已在跑的本地子进程不受 token 影响,必须立即强杀。
    if (termService.has(s.id)) termService.forceKill(s.id);
    killed += 1;
  }
  if (controllerTeardown) {
    for (const token of controllerTokens) {
      controllerTeardown.killByController(token, 'revoked');
    }
  }
  return { killed, rotated };
}
