// 安全:renderer reload(主窗 View 菜单 Cmd+R)/ 渲染进程崩溃后,main 的授权镜像与未决弹窗随之结算。
// 行为见同目录 README「renderer reload」。真实 agent-auth.service + 真实 renderer store(fake timers);
// 窗口的 webContents 是 EventEmitter,send 复刻 AgentAuthPrompt.onRequest(ensure → respond → confirmSessionGrant)。
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPendingForTest,
  answerAgentAuthRequest,
  requestAgentAuth,
} from '../../../electron/main/services/agent-auth.service';
import {
  AGENT_AUTH_CHANNELS,
  AGENT_AUTH_PROMPT_TIMEOUT_MS,
  type AgentAuthRequestPayload,
} from '../../../electron/shared/agent-auth-channels';
import {
  PROMPT_DENY_COOLDOWN_BASE_MS,
  PROMPT_RATE_MAX,
} from '../../../electron/main/lib/prompt-throttle';
import {
  _resetAgentAuthForTest,
  getAgentAuthEpoch,
  useAgentAuthStore,
} from '@/stores/agent-auth.store';

const electronMock = vi.hoisted(() => ({ windows: [] as { id: number }[] }));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => electronMock.windows),
    fromId: vi.fn((id: number) => electronMock.windows.find((w) => w.id === id) ?? null),
  },
}));
vi.mock('../../../electron/main/services/terminal-sessions.service', () => ({
  getAll: vi.fn(() => []),
  remove: vi.fn(),
}));
vi.mock('../../../electron/main/services/terminal.service', () => ({
  has: vi.fn(() => false),
  kill: vi.fn(),
  forceKill: vi.fn(),
}));

const WINDOW_ID = 1;
let webContents: EventEmitter & { send: (channel: string, payload: unknown) => void; getURL: () => string };
/** renderer 真的显示出来的弹窗数。 */
let shown = 0;
let unsubscribe: () => void = () => undefined;

function makeWebContents(): typeof webContents {
  return Object.assign(new EventEmitter(), {
    getURL: () => 'file:///renderer/index.html',
    send: (channel: string, raw: unknown) => {
      if (channel !== AGENT_AUTH_CHANNELS.REQUEST) return;
      const payload = raw as AgentAuthRequestPayload;
      const external = payload.external === true;
      void (async () => {
        const decision = await useAgentAuthStore
          .getState()
          .ensure({ method: payload.method, ...(external ? { external } : {}) });
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

const flush = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
/** 发起请求;结果统一成字符串(被节流 → 'THROTTLED')。 */
const request = (method = 'terminal.send_text'): Promise<string> =>
  requestAgentAuth({ method, ownerWindowId: WINDOW_ID }).then(
    (d) => d,
    () => 'THROTTLED',
  );
const displayed = (): boolean => useAgentAuthStore.getState().pending !== null;
const user = (kind: 'once' | 'session' | 'denied'): void => {
  const s = useAgentAuthStore.getState();
  if (kind === 'denied') s.deny();
  else s.grant(kind);
};
/** renderer 文档重建:store 回到初始态(授权态、弹窗都没了)。 */
function rebuildRenderer(): void {
  _resetAgentAuthForTest();
  shown = 0;
}
/** 主窗 Cmd+R:main 收到主框架非同文档导航,随后 renderer 文档重建。 */
function reload(): void {
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: 'file:///renderer/index.html',
  });
  rebuildRenderer();
}

async function grantSession(): Promise<void> {
  const p = request();
  await flush();
  user('session');
  expect(await p).toBe('session');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  _resetPendingForTest();
  _resetAgentAuthForTest();
  webContents = makeWebContents();
  electronMock.windows = [{ id: WINDOW_ID, isDestroyed: () => false, webContents } as { id: number }];
  shown = 0;
  unsubscribe = useAgentAuthStore.subscribe((s, prev) => {
    if (s.pending && s.pending !== prev.pending) shown += 1;
  });
});

afterEach(() => {
  unsubscribe();
  _resetPendingForTest();
  _resetAgentAuthForTest();
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** 40 次请求(每秒一次),用户每次都点「仅本次」→ 实际弹窗数。 */
async function fortyOnceRequests(): Promise<number> {
  for (let i = 0; i < 40; i += 1) {
    const p = request();
    await flush();
    if (displayed()) user('once');
    await p;
    await flush(1000);
  }
  return shown;
}

/** 连续 3 轮「请求 → 等满超时时长」→ 实际弹窗数(有冷却时第 2 轮紧接着超时发起,被挡)。 */
async function threeTimeouts(): Promise<number> {
  for (let i = 0; i < 3; i += 1) {
    const p = request();
    await flush(AGENT_AUTH_PROMPT_TIMEOUT_MS + 10);
    await p;
  }
  return shown;
}

/** 用户拒绝后立刻再请求 → 是否又弹窗。 */
async function promptsAgainRightAfterDeny(): Promise<boolean> {
  const p = request();
  await flush();
  user('denied');
  await p;
  const again = request();
  await flush();
  const prompted = displayed();
  if (prompted) user('denied');
  await again;
  return prompted;
}

describe.each([
  ['main 收到导航事件(Cmd+R)', reload],
  ['纵深:main 没收到任何事件,只是 renderer 授权态没了', rebuildRenderer],
])('「本次启动期间允许」后 renderer reload —— %s', (_name, lose) => {
  it(`40 次请求每次点「仅本次」→ 弹窗数不超过速率上限 ${PROMPT_RATE_MAX}`, async () => {
    await grantSession();
    lose();
    expect(await fortyOnceRequests()).toBeLessThanOrEqual(PROMPT_RATE_MAX);
  });

  it('无人应答超时后有冷却:超时后紧接着的请求不弹窗(3 轮只弹 2 次)', async () => {
    await grantSession();
    lose();
    expect(await threeTimeouts()).toBe(2);
  });

  it('用户拒绝后立刻再请求不再弹窗(进入拒绝冷却)', async () => {
    await grantSession();
    lose();
    expect(await promptsAgainRightAfterDeny()).toBe(false);
    await flush(PROMPT_DENY_COOLDOWN_BASE_MS);
    const p = request();
    await flush();
    expect(displayed()).toBe(true);
    user('once');
    expect(await p).toBe('once');
  });
});

describe('弹窗显示中 renderer reload', () => {
  it('未决请求立即按取消结算;同窗口的新请求马上可以弹窗(不锁到 5 分钟超时 + 冷却)', async () => {
    const first = request();
    await flush();
    expect(displayed()).toBe(true);
    reload();

    // 审计复现:此前要等 330s(300s 超时 + 30s 冷却,期间没有任何弹窗可见)。
    let lockedMs = 0;
    for (; lockedMs < 400_000; lockedMs += 10_000) {
      const p = request();
      await flush();
      if (displayed()) break;
      await p;
      await flush(10_000);
    }
    expect(lockedMs).toBe(0);
    expect(await first).toBe('denied');
  });

  it('reload 结算的不计拒绝:连续 5 次「弹窗 → reload」后仍可立即弹窗', async () => {
    for (let i = 0; i < 5; i += 1) {
      const p = request('debug.launch');
      await flush();
      reload();
      expect(await p).toBe('denied');
    }
    const p = request('debug.launch');
    await flush();
    expect(displayed()).toBe(true);
    user('once');
    expect(await p).toBe('once');
  });

  it('渲染进程崩溃(render-process-gone)同样结算未决请求', async () => {
    const first = request();
    await flush();
    webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(await first).toBe('denied');
    rebuildRenderer();
    const p = request();
    await flush();
    expect(displayed()).toBe(true);
    user('once');
    expect(await p).toBe('once');
  });

  it('同文档导航(hash / pushState)不结算', async () => {
    const first = request();
    await flush();
    webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: true,
      url: 'file:///renderer/index.html#x',
    });
    user('once');
    expect(await first).toBe('once');
  });
});
