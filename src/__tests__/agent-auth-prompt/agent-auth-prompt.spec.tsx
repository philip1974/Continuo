// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act, waitFor } from '@testing-library/react';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { AgentAuthPrompt } from '../../shell/AgentAuthPrompt';
import {
  _resetAgentAuthForTest,
  useAgentAuthStore,
} from '../../stores/agent-auth.store';

interface FakeAuthApi {
  onRequest: ReturnType<typeof vi.fn>;
  respond: ReturnType<typeof vi.fn>;
}

function installApi(auth: FakeAuthApi): void {
  Object.defineProperty(window, 'api', {
    value: { agentAuth: auth },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  _resetAgentAuthForTest();
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

function getButtons(): Record<string, HTMLButtonElement> {
  const out: Record<string, HTMLButtonElement> = {};
  for (const b of document.querySelectorAll<HTMLButtonElement>(
    '.wm-modal-content button',
  )) {
    out[b.textContent ?? ''] = b;
  }
  return out;
}

describe('AgentAuthPrompt — 渲染条件', () => {
  it('pending=null → 不渲染 Modal', () => {
    installApi({ onRequest: vi.fn(() => () => {}), respond: vi.fn() });
    render(<AgentAuthPrompt />);
    expect(document.querySelector('.wm-modal-content')).toBeNull();
  });

  it('pending 非空 → 渲染 Modal,文案带 method label', () => {
    installApi({ onRequest: vi.fn(() => () => {}), respond: vi.fn() });
    render(<AgentAuthPrompt />);

    act(() => {
      void useAgentAuthStore.getState().ensure({
        method: 'terminal.create_session',
        agentLabel: 'Claude Code',
      });
    });

    const modal = document.querySelector('.wm-modal-content');
    expect(modal).not.toBeNull();
    expect(modal!.textContent).toContain('新建一个 terminal');
    expect(modal!.textContent).toContain('Claude Code');
  });

  it('未识别的 method → 「调用 ${method}」', () => {
    installApi({ onRequest: vi.fn(() => () => {}), respond: vi.fn() });
    render(<AgentAuthPrompt />);
    act(() => {
      // 安全 S2 后 terminal.* 全部有专属标签;用插件自定义 method 测 generic fallback。
      void useAgentAuthStore.getState().ensure({ method: 'plugin.custom_tool' });
    });
    const modal = document.querySelector('.wm-modal-content')!;
    expect(modal.textContent).toContain('调用 plugin.custom_tool');
  });
});

describe('AgentAuthPrompt — 按钮', () => {
  function setup() {
    installApi({ onRequest: vi.fn(() => () => {}), respond: vi.fn() });
    render(<AgentAuthPrompt />);
    let promise: Promise<unknown> | null = null;
    act(() => {
      promise = useAgentAuthStore
        .getState()
        .ensure({ method: 'terminal.create_session' });
    });
    return promise!;
  }

  it('点拒绝 → store.deny + ensure resolve "denied"', async () => {
    const p = setup();
    fireEvent.click(getButtons()['拒绝']!);
    await expect(p).resolves.toBe('denied');
    expect(useAgentAuthStore.getState().pending).toBeNull();
  });

  it('点「仅本次」→ grant("once") + ensure resolve "once"', async () => {
    const p = setup();
    fireEvent.click(getButtons()['仅本次']!);
    await expect(p).resolves.toBe('once');
    expect(useAgentAuthStore.getState().sessionGranted).toBe(false);
  });

  it('点「本次启动期间允许」→ grant("session") + sessionGranted=true', async () => {
    const p = setup();
    fireEvent.click(getButtons()['本次启动期间允许']!);
    await expect(p).resolves.toBe('session');
    expect(useAgentAuthStore.getState().sessionGranted).toBe(true);
  });
});

describe('AgentAuthPrompt — 订阅 onRequest', () => {
  it('挂载时注册;收到 payload → ensure + respond;卸载 unsub', async () => {
    let cb: ((p: { requestId: string; method: string }) => void) | null = null;
    const onRequest = vi.fn((fn: (p: never) => void) => {
      cb = fn as never;
      return unsub;
    });
    const respond = vi.fn();
    const unsub = vi.fn();
    installApi({ onRequest, respond });

    const { unmount } = render(<AgentAuthPrompt />);
    expect(onRequest).toHaveBeenCalledTimes(1);

    act(() => {
      cb!({
        requestId: 'rq-1',
        method: 'terminal.create_session',
      });
    });

    // ensure 设了 pending,UI 弹出 Modal
    await waitFor(() => {
      expect(document.querySelector('.wm-modal-content')).not.toBeNull();
    });
    fireEvent.click(getButtons()['仅本次']!);
    await waitFor(() => {
      expect(respond).toHaveBeenCalledWith('rq-1', 'once');
    });

    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
