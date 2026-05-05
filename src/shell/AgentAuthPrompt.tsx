// Agent Terminal MCP — 授权弹窗(Phase 2)。
// 订阅 main 推的 'agent-auth:request' → 调 store.ensure → 等用户决定 → 应答 main。
// 已 sessionGranted 时 ensure 立刻返回 'session',Modal 不渲染。

import { useEffect } from 'react';
import { Button, Modal } from '@/design';
import { coApi } from '@/lib/co-api';
import { useAgentAuthStore } from '@/stores/agent-auth.store';

function methodLabel(method: string): string {
  if (method === 'terminal.create_session') return '新建一个 terminal';
  return `调用 ${method}`;
}

export function AgentAuthPrompt() {
  const pending = useAgentAuthStore((s) => s.pending);
  const grant = useAgentAuthStore((s) => s.grant);
  const deny = useAgentAuthStore((s) => s.deny);

  // 订阅 main 推的请求 — sessionGranted 时 ensure 自动短路返回 'session',
  // Modal 不渲染;否则 ensure 设 pending,UI 弹出。
  useEffect(() => {
    return coApi.agentAuth.onRequest(async ({ requestId, method, agentLabel }) => {
      const decision = await useAgentAuthStore.getState().ensure({
        method,
        ...(agentLabel !== undefined ? { agentLabel } : {}),
      });
      void coApi.agentAuth.respond(requestId, decision);
    });
  }, []);

  if (!pending) return null;

  return (
    <Modal visible onClose={deny} className="!max-w-[480px]">
      <h2 className="mb-1 text-sm font-medium text-fg">
        Agent 请求控制内置终端
      </h2>
      <p className="mb-3 text-xs text-fg-muted">
        外部 agent
        {pending.agentLabel ? (
          <>
            (<code className="text-fg">{pending.agentLabel}</code>)
          </>
        ) : null}{' '}
        通过 MCP 请求{methodLabel(pending.method)}。
      </p>
      <p className="mb-4 text-[10px] text-fg-dim">
        授权后,持有 MCP token 的 agent 可以创建 / 关闭 / 写入 / 读取 terminal。
        token 仅本次启动有效,Continuo 退出即作废。
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={deny}>
          拒绝
        </Button>
        <Button variant="ghost" size="sm" onClick={() => grant('once')}>
          仅本次
        </Button>
        <Button variant="primary" size="sm" onClick={() => grant('session')}>
          本次启动期间允许
        </Button>
      </div>
    </Modal>
  );
}
