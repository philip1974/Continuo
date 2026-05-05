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

export type AuthDecision = 'once' | 'session' | 'denied';

export interface PendingAuthRequest {
  readonly requestId: string;
  readonly method: string;
  readonly agentLabel?: string;
}

interface EnsureInfo {
  readonly method: string;
  readonly agentLabel?: string;
}

type AgentAuthState = {
  pending: PendingAuthRequest | null;
  sessionGranted: boolean;

  ensure(info: EnsureInfo): Promise<AuthDecision>;
  grant(kind: 'once' | 'session'): void;
  deny(): void;
  revoke(): void;
};

// 内部:挂起 Promise 的 resolver(zustand 状态外存,避免序列化函数)。
let pendingResolver: ((decision: AuthDecision) => void) | null = null;

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
  sessionGranted: false,

  ensure(info) {
    // 已 session 授权 → 直接通过,不设 pending(支持并发)
    if (get().sessionGranted) {
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
    };
    set({ pending: req });
    return new Promise<AuthDecision>((resolve) => {
      pendingResolver = resolve;
    });
  },

  grant(kind) {
    const resolver = pendingResolver;
    pendingResolver = null;
    if (kind === 'session') {
      set({ pending: null, sessionGranted: true });
    } else {
      set({ pending: null });
    }
    resolver?.(kind);
  },

  deny() {
    const resolver = pendingResolver;
    pendingResolver = null;
    set({ pending: null });
    resolver?.('denied');
  },

  revoke() {
    set({ sessionGranted: false });
  },
}));

/** 测试用:重置内部状态(状态 + 挂起 resolver). */
export function _resetAgentAuthForTest(): void {
  pendingResolver = null;
  useAgentAuthStore.setState({ pending: null, sessionGranted: false });
}
