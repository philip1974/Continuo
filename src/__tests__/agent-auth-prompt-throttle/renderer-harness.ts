// 规范共用:把真实 renderer store 接到假窗口的 webContents 上。send 复刻 AgentAuthPrompt.onRequest
// (ensure → respond → confirmSessionGrant);webContents 是 EventEmitter,可发导航 / 崩溃事件。
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import {
  answerAgentAuthRequest,
  requestAgentAuth,
} from '../../../electron/main/services/agent-auth.service';
import {
  AGENT_AUTH_CHANNELS,
  type AgentAuthRequestPayload,
} from '../../../electron/shared/agent-auth-channels';
import { getAgentAuthEpoch, useAgentAuthStore } from '@/stores/agent-auth.store';

export const WINDOW_ID = 1;

export type RendererWebContents = EventEmitter & {
  send: (channel: string, payload: unknown) => void;
  isDestroyed: () => boolean;
  getURL: () => string;
  /** 真实 WebContents 恒有;默认「主框架已加载完」,个别用例用 Object.assign 覆盖。 */
  isLoadingMainFrame: () => boolean;
};

export function makeRendererWebContents(): RendererWebContents {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getURL: () => 'file:///renderer/index.html',
    isLoadingMainFrame: () => false,
    send: (channel: string, raw: unknown) => {
      if (channel === AGENT_AUTH_CHANNELS.CANCELLED) {
        useAgentAuthStore.getState().cancel((raw as { requestId: string }).requestId);
        return;
      }
      if (channel !== AGENT_AUTH_CHANNELS.REQUEST) return;
      const payload = raw as AgentAuthRequestPayload;
      const external = payload.external === true;
      void (async () => {
        const decision = await useAgentAuthStore
          .getState()
          .ensure({
            requestId: payload.requestId,
            method: payload.method,
            ...(external ? { external } : {}),
          });
        if (decision === 'cancelled') return;
        const epoch = getAgentAuthEpoch();
        try {
          answerAgentAuthRequest(payload.requestId, decision, WINDOW_ID);
        } catch {
          return; // main 已结算(NOT_PENDING)
        }
        if (decision === 'session') {
          useAgentAuthStore.getState().confirmSessionGrant(payload.method, epoch, external);
        }
      })();
    },
  });
}

export const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

/** 发起请求;结果统一成字符串(被节流 → 'THROTTLED')。 */
export const request = (method = 'terminal.send_text', external = false): Promise<string> =>
  requestAgentAuth({ method, ownerWindowId: WINDOW_ID, ...(external ? { external } : {}) }).then(
    (d) => d,
    () => 'THROTTLED',
  );

/** renderer 当前是否显示着弹窗。 */
export const displayed = (): boolean => useAgentAuthStore.getState().pending !== null;

export const user = (kind: 'once' | 'session' | 'denied'): void => {
  const s = useAgentAuthStore.getState();
  if (kind === 'denied') s.deny();
  else s.grant(kind);
};
