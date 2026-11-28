// Agent Terminal MCP — 授权弹窗(Phase 2)。
// 订阅 main 推的 'agent-auth:request' → 调 store.ensure → 等用户决定 → 应答 main。
// 已「本次启动期间允许」的域在 main 直接放行,不会推到这里。

import { useCallback, useEffect, useId, type MouseEvent, type ReactNode } from 'react';
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
  isAgentAuthCancelledPayload,
  isAgentAuthRequestPayload,
} from '@shared/agent-auth-channels';
import { ERROR_CODES } from '@shared/error-codes';
import { ownValue } from '@shared/own-value';
import {
  PROMPT_GRANT_BUTTON_PROPS,
  usePromptGrantGuard,
  type PromptGrantGuard,
} from '@/lib/use-prompt-grant-guard';
import { PromptGrantHint } from '@/lib/prompt-grant-hint';
import { UNTRUSTED_PATH_MAX_CHARS, UntrustedText } from '@/lib/untrusted-text';
import { useTerminalStore } from '@/stores/terminal.store';
import { terminalPanelTitle, terminalTitleInputOf } from '@/shell/dock/terminal-panel-id';
import {
  MCP_TOOL_AWAIT_STOP_HOOK,
  MCP_TOOL_CREATE_SESSION,
  MCP_TOOL_KILL,
  MCP_TOOL_LIST_SESSIONS,
  MCP_TOOL_PRESS_KEY,
  MCP_TOOL_READ_OUTPUT,
  MCP_TOOL_SEND_INPUT,
  MCP_TOOL_SEND_TEXT,
} from '../../electron/shared/mcp-terminal-schemas';
import {
  DEBUG_AUTH_METHOD_CONTROL,
  DEBUG_AUTH_METHOD_LAUNCH,
} from '../../electron/shared/mcp-debug-schemas';

// method → i18n key 表（P2-1）；未知 method 走 generic('{method}') fallback
// 键取自工具名 / 授权 method 的共享常量(main 门控按同一常量发 method),不手抄字符串。
const METHOD_LABEL_KEYS: Record<string, TranslationKey> = {
  [MCP_TOOL_CREATE_SESSION]: 'permissions.agent.terminal_create_session',
  // 安全 S2:读/写/杀类工具也走授权门控,各自给清晰标签,帮用户识别异常访问。
  [MCP_TOOL_LIST_SESSIONS]: 'permissions.agent.terminal_list_sessions',
  [MCP_TOOL_READ_OUTPUT]: 'permissions.agent.terminal_read_output',
  [MCP_TOOL_SEND_INPUT]: 'permissions.agent.terminal_send_input',
  [MCP_TOOL_SEND_TEXT]: 'permissions.agent.terminal_send_text',
  [MCP_TOOL_PRESS_KEY]: 'permissions.agent.terminal_press_key',
  [MCP_TOOL_KILL]: 'permissions.agent.terminal_kill',
  [MCP_TOOL_AWAIT_STOP_HOOK]: 'permissions.agent.terminal_await_stop_hook',
  // debug 工具(main:mcp-debug-host)—— launch 单列,其余统一一个 method
  [DEBUG_AUTH_METHOD_LAUNCH]: 'permissions.agent.debug_launch',
  [DEBUG_AUTH_METHOD_CONTROL]: 'permissions.agent.debug_control',
};

/** 文案模板里对方可控字段的占位(先按它拆开模板,再把字段作为独立的 <code> 元素放进去)。 */
const UNTRUSTED_SLOT = ' __UNTRUSTED__ ';

export function AgentAuthPrompt() {
  const pending = useAgentAuthStore((s) => s.pending);
  // 请求首次出现、以及排队的下一个请求显示时,防误触延迟都重新计时。
  const guard = usePromptGrantGuard(pending?.requestId ?? null);

  // 订阅 main 推的请求(已授权域的请求 main 直接放行,不会推到这里)→ ensure 设 pending,UI 弹出。
  useEffect(() => {
    return coApi.agentAuth.onRequest(async (payload) => {
      // 边界(E171):IPC ingress runtime 守卫 —— 畸形 payload(null/缺 requestId·method/超长)drop +
      // warn,不解构(防 null 解构抛未处理 rejection)、不调 ensure/respond(防 main pending 超时)。
      if (!isAgentAuthRequestPayload(payload)) {
        console.warn('[agent-auth] invalid request payload, dropped', payload);
        return;
      }
      const { requestId, method } = payload;
      // 安全(F2):外部客户端(未绑定 Continuo 终端)的授权位记在界面副本的 external 一侧;放行由 main 判定。
      const external = payload.external === true;
      const decision = await useAgentAuthStore.getState().ensure({
        requestId,
        method,
        ...(external ? { external } : {}),
        ...(payload.details ? { details: payload.details } : {}),
      });
      // main 已撤销并结算了该请求(本地仅取消弹窗)→ 不再 respond:main 已无该 pending,会返回
      // NOT_PENDING 并弹出误导性的「授权响应失败」。
      if (decision === 'cancelled') return;
      const epoch = getAgentAuthEpoch();
      // a11y(A58,A50 同族):respond 返回 IpcResult 且可 reject。此前 void 丢弃 → IPC 应答失败时
      // 弹窗已关、main pending 等到无应答超时(2 分钟)才默认拒绝,用户/AT 不知决定未生效。失败给可见+可播报反馈。
      try {
        const r = await coApi.agentAuth.respond(requestId, decision);
        // 安全:「本次启动期间允许」仅在 main 确认该请求仍在等待(ok)后生效;main 已撤销/超时删除
        // 的旧请求 → ok:false(AGENT_AUTH_REQUEST_NOT_PENDING),不改变未来授权状态。
        if (r.ok && decision === 'session') {
          useAgentAuthStore.getState().confirmSessionGrant(method, epoch, external);
        }
        if (!r.ok) {
          console.warn('[agent-auth] respond failed', r.code, r.message);
          // race:main 已结算该请求、CANCELLED 通知还在路上时用户点了应答 → NOT_PENDING =
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

  // main 已结算某个请求(无应答超时 / 排队兜底 / 取消)→ 撤掉对应弹窗(renderer 不自行计时)。
  useEffect(() => {
    return coApi.agentAuth.onCancelled((payload) => {
      if (!isAgentAuthCancelledPayload(payload)) return;
      useAgentAuthStore.getState().cancel(payload.requestId);
    });
  }, []);

  // 跨窗口撤销:任一窗口撤销成功后 main 广播 REVOKED → 本窗口重置授权位的界面副本并取消残留弹窗
  //(否则撤销入口仍显示;残留弹窗对应的请求 main 已结算,用户点了只会得到 NOT_PENDING)。
  useEffect(() => {
    return coApi.agentAuth.onRevoked(() => {
      useAgentAuthStore.getState().applyMainRevoked();
    });
  }, []);

  if (!pending) return null;
  // key:每个请求一个 body 实例 → 排队的下一个请求显示时,初始焦点重新来过。
  return <AgentAuthPromptBody key={pending.requestId} pending={pending} guard={guard} />;
}

function AgentAuthPromptBody({
  pending,
  guard,
}: {
  readonly pending: NonNullable<ReturnType<typeof useAgentAuthStore.getState>['pending']>;
  readonly guard: PromptGrantGuard;
}) {
  const grantNow = useAgentAuthStore((s) => s.grant);
  // 键盘激活另须是停顿后的有意按键(见 use-prompt-grant-guard):Tab+Enter / 打字流里的 Space 不算。
  const grant = (kind: 'once' | 'session', e: MouseEvent<HTMLButtonElement>): void => {
    if (guard.canGrant(e)) grantNow(kind);
  };
  const denyNow = useAgentAuthStore((s) => s.deny);
  // 拒绝同样设防:被拒会进冷却(main prompt-throttle,连续被拒翻倍),打字流里落进弹窗的空格 / 回车 / Esc 不能变成拒绝。
  // 被守卫挡下的拒绝不应答 main,自然不计入冷却。
  const deny = (e: MouseEvent<HTMLButtonElement>): void => {
    if (guard.canGrant(e)) denyNow();
  };
  // Esc / 点遮罩 = 拒绝(VSCode 对话框 Esc = 取消),同样计入冷却;出现延迟内 / 输入流里的 Esc 不算。
  // 稳定引用:Modal 的焦点 / 键盘 effect 依赖 onClose,每次渲染换新函数会让它重跑(重新抢初始焦点)。
  const dismiss = useCallback((): void => {
    if (guard.canDismiss()) denyNow();
  }, [guard, denyNow]);
  const t = useT();
  const descriptionId = useId();
  // debug 域的请求:标题与说明讲调试器能做什么(授权也只记在 debug 域)。
  const isDebug = isDebugAuthMethod(pending.method);
  // 插件工具域(main plugin-mcp-bridge,method=plugin.<tool 名>):标题 / 说明讲插件工具。
  const isPlugin = isPluginAuthMethod(pending.method);

  // 安全:插件工具名由插件决定(未知 method 同理不是系统文案)。原样内联时,名字里的换行 + 伪系统提示看起来像
  // 弹窗自己的话,U+202E 等让显示与真实内容不符 → 可见化后放进等宽 <code>(lib/untrusted-text),与系统文案区分开。
  function methodLabel(method: string): ReactNode {
    const k = ownValue(METHOD_LABEL_KEYS, method);
    if (k) return t(k);
    const [before = '', after = ''] = isPlugin
      ? t('permissions.agent.plugin_tool', { name: UNTRUSTED_SLOT }).split(UNTRUSTED_SLOT)
      : t('permissions.agent.generic', { method: UNTRUSTED_SLOT }).split(UNTRUSTED_SLOT);
    const shown = isPlugin
      ? method.slice(AGENT_AUTH_PLUGIN_METHOD_PREFIX.length)
      : method;
    return (
      <>
        {before}
        <UntrustedText text={shown} />
        {after}
      </>
    );
  }
  // 窗口内终端里的 agent 不是「外部」agent:说明句按调用方类别区分。
  const [bodyBefore = '', bodyAfter = ''] = t(
    pending.external ? 'permissions.agent.body_external' : 'permissions.agent.body',
    { action: UNTRUSTED_SLOT },
  ).split(UNTRUSTED_SLOT);
  const details = pending.details;
  // 发起终端:main 按调用方 token 反查的会话 id → 本窗口终端 store 里的标题(同 tab 标题,含 agent 标签后缀)。
  const callerSessionId = pending.external ? undefined : details?.callerSessionId;
  const callerTitle = useTerminalStore((st) => {
    if (callerSessionId === undefined) return null;
    const found = st.sessions.find((x) => x.id === callerSessionId);
    return found ? terminalPanelTitle(terminalTitleInputOf(found)) : null;
  });
  // 一条「标签:{value}」说明,value 为对方可控文本(可见化后放进 <code>)。
  function detailLine(key: TranslationKey, value: string | undefined, max?: number): ReactNode {
    if (!value) return null;
    const [before = '', after = ''] = t(key, { value: UNTRUSTED_SLOT }).split(UNTRUSTED_SLOT);
    return (
      <li>
        {before}
        <UntrustedText text={value} {...(max !== undefined ? { max } : {})} />
        {after}
      </li>
    );
  }
  const detailLines = [
    callerTitle !== null ? detailLine('permissions.agent.caller_terminal', callerTitle) : null,
    detailLine('permissions.agent.detail_agent_label', details?.agentLabel),
    detailLine('permissions.agent.detail_command', details?.command, UNTRUSTED_PATH_MAX_CHARS),
    detailLine('permissions.agent.detail_program', details?.program, UNTRUSTED_PATH_MAX_CHARS),
    detailLine('permissions.agent.detail_cwd', details?.cwd, UNTRUSTED_PATH_MAX_CHARS),
  ].filter((line) => line !== null);
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
    <Modal
      visible
      onClose={dismiss}
      aria-labelledby="agent-auth-title"
      aria-describedby={descriptionId}
      // 初始焦点在对话框容器上(不在任何按钮上):弹窗在用户打字时出现,空格 / 回车不点下按钮;Tab 进入按钮。
      data-autofocus=""
    >
      {/* a11y(A13):dialog 关联标题。 */}
      <h2 id="agent-auth-title" className="mb-1 text-sm font-medium text-fg">
        {t(titleKey)}
      </h2>
      {/* a11y:请求说明(动作名 / 调用方 / 关键参数 / 授权后果)经 aria-describedby 关联 —— 初始焦点在对话框容器上,
          不关联时读屏只读标题,听不到请求的是什么。 */}
      <div id={descriptionId}>
        {/* 一条带 {action} 插值的完整句子(各语言自己决定空格 / 标点 / 语序);方法标签是 ReactNode(插件工具名等
            不可信文本要可见化),按占位符拆成前后两段嵌入。 */}
        <p className="mb-3 text-xs text-fg-muted">
          {bodyBefore}
          {methodLabel(pending.method)}
          {bodyAfter}
        </p>
        {/* 是哪个 agent、要做什么:发起终端与关键参数(都来自 agent,只作显示,不影响授权判定)。 */}
        {detailLines.length > 0 ? (
          <ul className="mb-3 space-y-1 text-xs text-fg-muted">{detailLines}</ul>
        ) : null}
        {/* 安全(F2):外部客户端请求标注来源 —— 弹窗出现在主窗,但调用方并非该窗口终端里的 agent。 */}
        {pending.external ? (
          <p className="mb-3 text-xs text-fg">{t('permissions.agent.external_caller')}</p>
        ) : null}
        <p className="mb-1 text-2xs text-fg-dim">
          {t(hintKey)}
        </p>
      </div>
      {/* 「尚未生效」提示的常驻 status 区域放在按钮上方(占说明与按钮之间的间距),底部不多出空白。 */}
      <PromptGrantHint guard={guard} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" {...PROMPT_GRANT_BUTTON_PROPS} onClick={deny}>
          {t('permissions.agent.deny')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          {...PROMPT_GRANT_BUTTON_PROPS}
          onClick={(e) => grant('once', e)}
        >
          {t('permissions.agent.grant_once')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          {...PROMPT_GRANT_BUTTON_PROPS}
          onClick={(e) => grant('session', e)}
        >
          {t('permissions.agent.grant_session')}
        </Button>
      </div>
    </Modal>
  );
}
