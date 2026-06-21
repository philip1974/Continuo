// Agent Terminal MCP — 授权弹窗(Phase 2)。
// 订阅 main 推的 'agent-auth:request' → 调 store.ensure → 等用户决定 → 应答 main。
// 已 sessionGranted 时 ensure 立刻返回 'session',Modal 不渲染。

import { useEffect } from 'react';
import { Button, Modal } from '@/design';
import { coApi } from '@/lib/co-api';
import { useAgentAuthStore } from '@/stores/agent-auth.store';
import { useT, type TranslationKey } from '@/i18n';

// method → i18n key 表（P2-1）；未知 method 走 generic('{method}') fallback
const METHOD_LABEL_KEYS: Record<string, TranslationKey> = {
  'terminal.create_session': 'permissions.agent.terminal_create_session',
  // 安全 S2:读/写/杀类工具也走授权门控,各自给清晰标签,帮用户识别异常访问。
  'terminal.list_sessions': 'permissions.agent.terminal_list_sessions',
  'terminal.read_output': 'permissions.agent.terminal_read_output',
  'terminal.send_input': 'permissions.agent.terminal_send_input',
  'terminal.send_text': 'permissions.agent.terminal_send_text',
  'terminal.press_key': 'permissions.agent.terminal_press_key',
  'terminal.kill': 'permissions.agent.terminal_kill',
};

export function AgentAuthPrompt() {
  const pending = useAgentAuthStore((s) => s.pending);
  const grant = useAgentAuthStore((s) => s.grant);
  const deny = useAgentAuthStore((s) => s.deny);
  const t = useT();

  function methodLabel(method: string): string {
    const k = METHOD_LABEL_KEYS[method];
    if (k) return t(k);
    return t('permissions.agent.generic', { method });
  }

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
    <Modal visible onClose={deny}>
      <h2 className="mb-1 text-sm font-medium text-fg">
        {t('permissions.agent.title')}
      </h2>
      <p className="mb-3 text-xs text-fg-muted">
        {t('permissions.agent.body_prefix')}
        {pending.agentLabel ? (
          <>
            {' '}(<code className="text-fg">{pending.agentLabel}</code>)
          </>
        ) : null}{' '}
        {t('permissions.agent.body_via_mcp')}
        {methodLabel(pending.method)}
        {t('permissions.agent.body_suffix')}
      </p>
      <p className="mb-4 text-2xs text-fg-dim">
        {t('permissions.agent.hint')}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={deny}>
          {t('permissions.agent.deny')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => grant('once')}>
          {t('permissions.agent.grant_once')}
        </Button>
        <Button variant="primary" size="sm" onClick={() => grant('session')}>
          {t('permissions.agent.grant_session')}
        </Button>
      </div>
    </Modal>
  );
}
