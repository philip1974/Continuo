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

// 5 分钟无应答 → 默认拒绝(防 renderer 卡死时 tool Promise 永远悬挂)
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

const pending = new Map<string, (decision: AgentAuthDecision) => void>();

function pickMainWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows();
  // 优先非 popout 主窗(popout 子窗不挂 AgentAuthPrompt UI)
  for (const w of wins) {
    if (w.isDestroyed()) continue;
    const url = w.webContents.getURL();
    if (!url.includes('popout=1')) return w;
  }
  return wins.find((w) => !w.isDestroyed()) ?? null;
}

export interface AgentAuthInfo {
  readonly method: string;
  readonly agentLabel?: string;
}

/**
 * Tool 调用入口:把请求 push 给主窗,等用户决定。
 * 主窗不存在 / 5 分钟超时 → 默认 'denied'(防卡死)。
 */
export async function requestAgentAuth(
  info: AgentAuthInfo,
): Promise<AgentAuthDecision> {
  const win = pickMainWindow();
  if (!win) return 'denied';
  const requestId = `req-${crypto.randomUUID()}`;
  return new Promise<AgentAuthDecision>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        resolve('denied');
      }
    }, PROMPT_TIMEOUT_MS);
    pending.set(requestId, (decision) => {
      clearTimeout(timer);
      resolve(decision);
    });
    const payload: AgentAuthRequestPayload = {
      requestId,
      method: info.method,
      ...(info.agentLabel !== undefined ? { agentLabel: info.agentLabel } : {}),
    };
    win.webContents.send(AGENT_AUTH_CHANNELS.REQUEST, payload);
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
  r(decision);
}

/** 测试用:清空所有 pending(test 隔离). */
export function _resetPendingForTest(): void {
  for (const [, r] of pending) r('denied');
  pending.clear();
}
