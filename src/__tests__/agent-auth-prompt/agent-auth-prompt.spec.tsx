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
  onRevoked?: ReturnType<typeof vi.fn>;
}

function installApi(auth: FakeAuthApi): void {
  Object.defineProperty(window, 'api', {
    value: { agentAuth: { onRevoked: vi.fn(() => () => {}), ...auth } },
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

  // main 对 debug 工具发 method='debug.launch' / 'debug.*';此前标签表只有 terminal.*,弹窗显示原始串。
  it.each([
    ['debug.launch', '启动调试会话'],
    ['debug.*', '控制调试会话'],
  ])('debug method %s → 本地化标签,不显示原始 method', (method, label) => {
    installApi({ onRequest: vi.fn(() => () => {}), respond: vi.fn() });
    render(<AgentAuthPrompt />);
    act(() => {
      void useAgentAuthStore.getState().ensure({ method });
    });
    const modal = document.querySelector('.wm-modal-content');
    expect(modal!.textContent).toContain(label);
    expect(modal!.textContent).not.toContain(method);
  });

  it('debug 请求的弹窗标题与说明讲的是调试,不是终端', () => {
    installApi({ onRequest: vi.fn(() => () => {}), respond: vi.fn() });
    render(<AgentAuthPrompt />);
    act(() => {
      void useAgentAuthStore.getState().ensure({ method: 'debug.launch' });
    });
    const modal = document.querySelector('.wm-modal-content')!;
    expect(modal.textContent).toContain('Agent 请求控制调试器');
    expect(modal.textContent).not.toContain('Agent 请求控制内置终端');
    expect(modal.textContent).toContain('读取变量');
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

  it('点「本次启动期间允许」→ grant("session")(域授权待 main 确认,见下方 respond 用例)', async () => {
    const p = setup();
    fireEvent.click(getButtons()['本次启动期间允许']!);
    await expect(p).resolves.toBe('session');
    expect(useAgentAuthStore.getState().sessionGranted).toBe(false);
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

  // 「本次启动期间允许」只有在 main 确认该 requestId 仍在等待(respond ok)后才生效:main 已撤销/超时
  // 删除的旧请求 → respond 失败 → 不得把 sessionGranted 置 true(否则之后的请求被静默放行)。
  it.each([
    ['ok=false', async () => ({ ok: false, code: 'AGENT_AUTH_REQUEST_NOT_PENDING', message: 'x' })],
    ['reject', async () => Promise.reject(new Error('ipc down'))],
  ])('respond %s → 「本次启动期间允许」不改变未来授权状态', async (_label, impl) => {
    notifyError.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let cb: ((p: { requestId: string; method: string }) => void) | null = null;
    const onRequest = vi.fn((fn: (p: never) => void) => {
      cb = fn as never;
      return vi.fn();
    });
    const respond = vi.fn(impl);
    installApi({ onRequest, respond });
    render(<AgentAuthPrompt />);
    act(() => {
      cb!({ requestId: 'stale-1', method: 'terminal.create_session' });
    });
    await waitFor(() => {
      expect(document.querySelector('.wm-modal-content')).not.toBeNull();
    });
    fireEvent.click(getButtons()['本次启动期间允许']!);
    await waitFor(() => {
      expect(respond).toHaveBeenCalledWith('stale-1', 'session');
    });
    await waitFor(() => expect(notifyError).toHaveBeenCalled());
    expect(useAgentAuthStore.getState().sessionGranted).toBe(false);
  });

  it('respond ok → 「本次启动期间允许」生效(后续请求直接通过)', async () => {
    let cb: ((p: { requestId: string; method: string }) => void) | null = null;
    const onRequest = vi.fn((fn: (p: never) => void) => {
      cb = fn as never;
      return vi.fn();
    });
    const respond = vi.fn(async () => ({ ok: true }));
    installApi({ onRequest, respond });
    render(<AgentAuthPrompt />);
    act(() => {
      cb!({ requestId: 'rq-1', method: 'terminal.create_session' });
    });
    await waitFor(() => {
      expect(document.querySelector('.wm-modal-content')).not.toBeNull();
    });
    fireEvent.click(getButtons()['本次启动期间允许']!);
    await waitFor(() => {
      expect(useAgentAuthStore.getState().sessionGranted).toBe(true);
    });
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

// 撤销导致的本地取消:main 撤销时已把全部 pending 结算为 denied 并删除。renderer 取消残留弹窗后若仍
// respond(requestId,'denied'),main 返回 AGENT_AUTH_REQUEST_NOT_PENDING → 误导性「授权响应失败」toast。
// 跨窗口:其它窗口发起的撤销经 REVOKED 广播到达,本窗口须同样重置授权态并取消弹窗。
describe('AgentAuthPrompt — main 已撤销', () => {
  function setupWithRequest() {
    notifyError.mockReset();
    let cb: ((p: { requestId: string; method: string }) => void) | null = null;
    let revokedCb: (() => void) | null = null;
    const onRequest = vi.fn((fn: (p: never) => void) => {
      cb = fn as never;
      return vi.fn();
    });
    const onRevoked = vi.fn((fn: () => void) => {
      revokedCb = fn;
      return vi.fn();
    });
    const respond = vi.fn(async () => ({
      ok: false,
      code: 'AGENT_AUTH_REQUEST_NOT_PENDING',
      message: 'x',
    }));
    installApi({ onRequest, respond, onRevoked });
    const view = render(<AgentAuthPrompt />);
    return {
      view,
      onRevoked,
      respond,
      fireRequest: (id: string, method = 'terminal.create_session') => cb!({ requestId: id, method }),
      fireRevoked: () => revokedCb!(),
    };
  }

  it('弹窗本地超时(与 main 同 TTL,main 已结算删除)→ 不 respond、不弹失败 toast', async () => {
    vi.useFakeTimers();
    try {
      const { respond, fireRequest } = setupWithRequest();
      act(() => {
        void fireRequest('rq-timeout');
      });
      expect(useAgentAuthStore.getState().pending?.requestId).toBeDefined();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      });
      expect(useAgentAuthStore.getState().pending).toBeNull();
      expect(respond).not.toHaveBeenCalled();
      expect(notifyError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('撤销成功后取消本地弹窗(applyMainRevoked)→ 不再向 main respond、不弹失败 toast', async () => {
    const { respond, fireRequest } = setupWithRequest();
    act(() => {
      void fireRequest('rq-r1');
    });
    await waitFor(() => {
      expect(document.querySelector('.wm-modal-content')).not.toBeNull();
    });
    act(() => {
      useAgentAuthStore.getState().applyMainRevoked();
    });
    await waitFor(() => {
      expect(document.querySelector('.wm-modal-content')).toBeNull();
    });
    // 让 ensure 的 await 链走完
    await act(async () => {
      await Promise.resolve();
    });
    expect(respond).not.toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('收到 REVOKED 广播 → 清 session 授权 + 取消弹窗,且不 respond', async () => {
    const { respond, fireRequest, fireRevoked, onRevoked } = setupWithRequest();
    expect(onRevoked).toHaveBeenCalledTimes(1);
    useAgentAuthStore.setState({ sessionGranted: true });
    // debug 域未授权 → 弹窗(经 onRequest 进入,验证取消后不 respond)
    act(() => {
      void fireRequest('rq-debug', 'debug.launch');
    });
    await waitFor(() => {
      expect(document.querySelector('.wm-modal-content')).not.toBeNull();
    });

    act(() => {
      fireRevoked();
    });

    expect(useAgentAuthStore.getState().sessionGranted).toBe(false);
    expect(useAgentAuthStore.getState().debugSessionGranted).toBe(false);
    await waitFor(() => {
      expect(document.querySelector('.wm-modal-content')).toBeNull();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(respond).not.toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('卸载 → 退订 REVOKED', () => {
    const unsub = vi.fn();
    installApi({
      onRequest: vi.fn(() => () => {}),
      respond: vi.fn(),
      onRevoked: vi.fn(() => unsub),
    });
    const { unmount } = render(<AgentAuthPrompt />);
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
