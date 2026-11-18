// Agent Terminal MCP — 授权弹窗(Phase 2)。
// 订阅 main 推的 'agent-auth:request' → 调 store.ensure → 等用户决定 → 应答 main。
// 已 sessionGranted 时 ensure 立刻返回 'session',Modal 不渲染。

import { useEffect, useState } from 'react';
import { Button, Modal } from '@/design';
import { coApi } from '@/lib/co-api';
import {
  getAgentAuthEpoch,
  isDebugAuthMethod,
  isPluginAuthMethod,
  useAgentAuthStore,
} from '@/stores/agent-auth.store';
import { notify } from '@/notifications/notify';
import { useT, t as translate, type TranslationKey } from '@/i18n';
import {
  AGENT_AUTH_PLUGIN_METHOD_PREFIX,
  isAgentAuthRequestPayload,
} from '@shared/agent-auth-channels';
import { ERROR_CODES } from '@shared/error-codes';
import { ownValue } from '@shared/own-value';

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
  // debug 工具(main:mcp-debug-host)—— launch 单列,其余统一 debug.*
  'debug.launch': 'permissions.agent.debug_launch',
  'debug.*': 'permissions.agent.debug_control',
};

/**
 * 安全:弹窗显示后这段时间内忽略「允许」类按钮的激活(鼠标与键盘)。弹窗会抢走键盘焦点,用户正在终端 / 编辑器
 * 打字或点击时,落进弹窗的按键(Tab+Enter)/ 连点不能变成授予。只对授予方向设防:「拒绝」与 Esc 立即可用。
 * 与 plugins/permissions/PermissionPrompt 的切换守卫同值;那边只守「请求直接换成下一个」,这里首次出现也守
 * (授权请求的时机由 agent 决定)。design Modal 是与 Nous 共享的副本,不在那一层加。
 */
export const AGENT_AUTH_GRANT_ARM_DELAY_MS = 500;

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
      // 安全(F2):外部客户端(未绑定 Continuo 终端)只读写 external 授权状态,不复用窗口级授权。
      const external = payload.external === true;
      const decision = await useAgentAuthStore.getState().ensure({
        method,
        ...(agentLabel !== undefined ? { agentLabel } : {}),
        ...(external ? { external } : {}),
      });
      // main 已撤销并结算了该请求(本地仅取消弹窗)→ 不再 respond:main 已无该 pending,会返回
      // NOT_PENDING 并弹出误导性的「授权响应失败」。
      if (decision === 'cancelled') return;
      const epoch = getAgentAuthEpoch();
      // a11y(A58,A50 同族):respond 返回 IpcResult 且可 reject。此前 void 丢弃 → IPC 应答失败时
      // 弹窗已关、main pending 等 5 分钟才默认拒绝,用户/AT 不知决定未生效。失败给可见+可播报反馈。
      try {
        const r = await coApi.agentAuth.respond(requestId, decision);
        // 安全:「本次启动期间允许」仅在 main 确认该请求仍在等待(ok)后生效;main 已撤销/超时删除
        // 的旧请求 → ok:false(AGENT_AUTH_REQUEST_NOT_PENDING),不改变未来授权状态。
        if (r.ok && decision === 'session') {
          useAgentAuthStore.getState().confirmSessionGrant(method, epoch, external);
        }
        if (!r.ok) {
          console.warn('[agent-auth] respond failed', r.code, r.message);
          // race:main 与本地弹窗计时起点相差 IPC 延迟 —— 本地尚未超时而 main 已结算 → NOT_PENDING =
          // 请求已失效(已按拒绝收场),不是应答失败,不弹误导性 toast。其它失败码照旧提示。
          if (r.code !== ERROR_CODES.AGENT_AUTH_REQUEST_NOT_PENDING) {
            notify.error(translate('permissions.agent.respond_failed'));
          }
        }
      } catch (err) {
        console.warn('[agent-auth] respond threw', err);
        notify.error(translate('permissions.agent.respond_failed'));
      }
    });
  }, []);

  // 跨窗口撤销:任一窗口撤销成功后 main 广播 REVOKED → 本窗口同样重置授权态并取消残留弹窗,
  // 否则本窗口的「本次启动期间允许」仍生效,撤销后的请求被静默放行。
  useEffect(() => {
    return coApi.agentAuth.onRevoked(() => {
      useAgentAuthStore.getState().applyMainRevoked();
    });
  }, []);

  if (!pending) return null;
  // key:每个请求一个 body 实例 → 排队的下一个请求显示时,防误触延迟与初始焦点都重新来过。
  return <AgentAuthPromptBody key={pending.requestId} pending={pending} />;
}

function AgentAuthPromptBody({
  pending,
}: {
  readonly pending: NonNullable<ReturnType<typeof useAgentAuthStore.getState>['pending']>;
}) {
  const grantNow = useAgentAuthStore((s) => s.grant);
  const [shownAt] = useState(() => Date.now());
  const grant = (kind: 'once' | 'session'): void => {
    if (Date.now() - shownAt >= AGENT_AUTH_GRANT_ARM_DELAY_MS) grantNow(kind);
  };
  const deny = useAgentAuthStore((s) => s.deny);
  const t = useT();
  // debug 域的请求:标题与说明讲调试器能做什么(授权也只记在 debug 域)。
  const isDebug = isDebugAuthMethod(pending.method);
  // 插件工具域(main plugin-mcp-bridge,method=plugin.<tool 名>):标题 / 说明讲插件工具。
  const isPlugin = isPluginAuthMethod(pending.method);

  function methodLabel(method: string): string {
    const k = ownValue(METHOD_LABEL_KEYS, method);
    if (k) return t(k);
    if (isPluginAuthMethod(method)) {
      return t('permissions.agent.plugin_tool', {
        name: method.slice(AGENT_AUTH_PLUGIN_METHOD_PREFIX.length),
      });
    }
    return t('permissions.agent.generic', { method });
  }
  const titleKey: TranslationKey = isDebug
    ? 'permissions.agent.title_debug'
    : isPlugin
      ? 'permissions.agent.title_plugin'
      : 'permissions.agent.title';
  const hintKey: TranslationKey = isDebug
    ? 'permissions.agent.hint_debug'
    : isPlugin
      ? 'permissions.agent.hint_plugin'
      : 'permissions.agent.hint';

  return (
    <Modal visible onClose={deny} aria-labelledby="agent-auth-title">
      {/* a11y(A13):dialog 关联标题。 */}
      <h2 id="agent-auth-title" className="mb-1 text-sm font-medium text-fg">
        {t(titleKey)}
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
      {/* 安全(F2):外部客户端请求标注来源 —— 弹窗出现在主窗,但调用方并非该窗口终端里的 agent。 */}
      {pending.external ? (
        <p className="mb-3 text-xs text-fg">{t('permissions.agent.external_caller')}</p>
      ) : null}
      <p className="mb-4 text-2xs text-fg-dim">
        {t(hintKey)}
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
