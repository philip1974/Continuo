// Agent Terminal MCP — 授权弹窗(Phase 2)。
// 订阅 main 推的 'agent-auth:request' → 调 store.ensure → 等用户决定 → 应答 main。
// 已 sessionGranted 时 ensure 立刻返回 'session',Modal 不渲染。

import { useEffect } from 'react';
import { Button, Modal } from '@/design';
import { coApi } from '@/lib/co-api';
import { useAgentAuthStore } from '@/stores/agent-auth.store';
import { notify } from '@/notifications/notify';
import { useT, t as translate, type TranslationKey } from '@/i18n';
import { isAgentAuthRequestPayload } from '@shared/agent-auth-channels';

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

  // 订阅 main 推的请求 — sessionGranted 时 ensure 自动短路返回 'session',
  // Modal 不渲染;否则 ensure 设 pending,UI 弹出。
  useEffect(() => {
    return coApi.agentAuth.onRequest(async (payload) => {
      // 边界(E171):IPC ingress runtime 守卫 —— 畸形 payload(null/缺 requestId·method/超长)drop +
      // warn,不解构(防 null 解构抛未处理 rejection)、不调 ensure/respond(防 main pending 超时)。
      if (!isAgentAuthRequestPayload(payload)) {
        console.warn('[agent-auth] invalid request payload, dropped', payload);
        return;
      }
      const { requestId, method, agentLabel } = payload;
      const decision = await useAgentAuthStore.getState().ensure({
        method,
        ...(agentLabel !== undefined ? { agentLabel } : {}),
      });
      // a11y(A58,A50 同族):respond 返回 IpcResult 且可 reject。此前 void 丢弃 → IPC 应答失败时
      // 弹窗已关、main pending 等 5 分钟才默认拒绝,用户/AT 不知决定未生效。失败给可见+可播报反馈。
      try {
        const r = await coApi.agentAuth.respond(requestId, decision);
        if (!r.ok) {
          console.warn('[agent-auth] respond failed', r.code, r.message);
          notify.error(translate('permissions.agent.respond_failed'));
        }
      } catch (err) {
        console.warn('[agent-auth] respond threw', err);
        notify.error(translate('permissions.agent.respond_failed'));
      }
    });
  }, []);

  if (!pending) return null;
  return <AgentAuthPromptBody pending={pending} />;
}

function AgentAuthPromptBody({
  pending,
}: {
  readonly pending: NonNullable<ReturnType<typeof useAgentAuthStore.getState>['pending']>;
}) {
  const grant = useAgentAuthStore((s) => s.grant);
  const deny = useAgentAuthStore((s) => s.deny);
  const t = useT();

  function methodLabel(method: string): string {
    const k = METHOD_LABEL_KEYS[method];
    if (k) return t(k);
    return t('permissions.agent.generic', { method });
  }

  return (
    <Modal visible onClose={deny} aria-labelledby="agent-auth-title">
      {/* a11y(A13):dialog 关联标题。 */}
      <h2 id="agent-auth-title" className="mb-1 text-sm font-medium text-fg">
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
