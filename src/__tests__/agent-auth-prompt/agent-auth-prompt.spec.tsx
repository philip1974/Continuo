// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

const notifyError = vi.fn();
vi.mock('../../notifications/notify', () => ({
  notify: { error: (...a: unknown[]) => notifyError(...a) },
}));

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
  it('pending=null shell 保留 onRequest 订阅,但不调用 useT', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/shell/AgentAuthPrompt.tsx'),
      'utf-8',
    );
    const shellStart = src.indexOf('export function AgentAuthPrompt()');
    const bodyStart = src.indexOf('function AgentAuthPromptBody');
    const shellSrc = src.slice(shellStart, bodyStart);

    expect(shellStart).toBeGreaterThanOrEqual(0);
    expect(bodyStart).toBeGreaterThan(shellStart);
    expect(shellSrc).toContain('coApi.agentAuth.onRequest');
    expect(shellSrc).toContain('if (!pending) return null;');
    expect(shellSrc).not.toContain('useT(');
    expect(src.indexOf('const t = useT();')).toBeGreaterThan(bodyStart);
  });

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
    // respond 真实返回 IpcResult(A58:调用点检查 !ok / catch)→ mock 返成功。
    const respond = vi.fn(async () => ({ ok: true }));
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

  // a11y(A58,A50 同族):respond 失败(ok=false / reject)此前 void 丢弃 → 用户/AT 不知决定未生效。
  it('a11y · respond ok=false → notify.error 反馈', async () => {
    notifyError.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let cb: ((p: { requestId: string; method: string }) => void) | null = null;
    const onRequest = vi.fn((fn: (p: never) => void) => {
      cb = fn as never;
      return vi.fn();
    });
    const respond = vi.fn(async () => ({ ok: false, code: 'IPC_FAIL', message: 'x' }));
    installApi({ onRequest, respond });
    render(<AgentAuthPrompt />);
    act(() => {
      cb!({ requestId: 'rq-1', method: 'terminal.create_session' });
    });
    await waitFor(() => {
      expect(document.querySelector('.wm-modal-content')).not.toBeNull();
    });
    fireEvent.click(getButtons()['仅本次']!);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledTimes(1);
    });
  });

  // 边界(E171,E168/E169/E170 同族 IPC ingress 纵深防御):畸形 agent-auth:request payload runtime
  // 校验失败 → drop + warn,不解构(防 null 解构抛 rejection)、不调 ensure/respond(防 main pending
  // 超时)、不弹 Modal。
  it('E171 畸形 payload(null/缺 requestId·method/超长)→ drop,不弹 Modal/不 respond', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let cb: ((p: unknown) => void) | null = null;
    const onRequest = vi.fn((fn: (p: never) => void) => {
      cb = fn as never;
      return vi.fn();
    });
    const respond = vi.fn(async () => ({ ok: true }));
    installApi({ onRequest, respond });
    render(<AgentAuthPrompt />);

    const bad: unknown[] = [
      null,
      'a string',
      { method: 'terminal.kill' }, // 缺 requestId
      { requestId: 'rq' }, // 缺 method
      { requestId: '', method: 'terminal.kill' }, // 空 requestId
      { requestId: 'rq', method: '' }, // 空 method
      { requestId: 'x'.repeat(257), method: 'terminal.kill' }, // 超长 requestId
      { requestId: 'rq', method: 'm'.repeat(257) }, // 超长 method
      { requestId: 'rq', method: 'terminal.kill', agentLabel: 'z'.repeat(513) }, // 超长 label
    ];
    for (const p of bad) {
      // 不应抛(尤其 null 解构):用 act 包裹并断言不 throw
      act(() => {
        cb!(p);
      });
    }
    // 无 Modal 弹出、respond 从未调用
    expect(document.querySelector('.wm-modal-content')).toBeNull();
    expect(respond).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('E171 合规 payload(含 agentLabel)→ 正常弹 Modal(回归)', async () => {
    let cb: ((p: unknown) => void) | null = null;
    const onRequest = vi.fn((fn: (p: never) => void) => {
      cb = fn as never;
      return vi.fn();
    });
    const respond = vi.fn(async () => ({ ok: true }));
    installApi({ onRequest, respond });
    render(<AgentAuthPrompt />);
    act(() => {
      cb!({ requestId: 'rq-ok', method: 'terminal.create_session', agentLabel: 'codex' });
    });
    await waitFor(() => {
      expect(document.querySelector('.wm-modal-content')).not.toBeNull();
    });
  });
});
