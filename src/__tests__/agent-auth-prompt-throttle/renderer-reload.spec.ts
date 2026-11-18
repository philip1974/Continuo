// 安全:renderer reload(主窗 View 菜单 Cmd+R)/ 渲染进程崩溃后,main 的授权镜像与未决弹窗随之结算。
// 行为见同目录 README「renderer reload」。真实 agent-auth.service + 真实 renderer store(fake timers);
// 窗口与 renderer 的接法见 renderer-harness.ts。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPendingForTest,
  markAgentAuthRendererReady,
  requestAgentAuth,
  watchAgentAuthRenderer,
} from '../../../electron/main/services/agent-auth.service';
import { AGENT_AUTH_PROMPT_TIMEOUT_MS } from '../../../electron/shared/agent-auth-channels';
import {
  PROMPT_DENY_COOLDOWN_BASE_MS,
  PROMPT_RATE_MAX,
} from '../../../electron/main/lib/prompt-throttle';
import { _resetAgentAuthForTest, useAgentAuthStore } from '@/stores/agent-auth.store';
import {
  WINDOW_ID,
  displayed,
  flush,
  makeRendererWebContents,
  request,
  user,
  type RendererWebContents,
} from './renderer-harness';

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

let webContents: RendererWebContents;
/** renderer 真的显示出来的弹窗数。 */
let shown = 0;
let unsubscribe: () => void = () => undefined;

/** renderer 文档重建:store 回到初始态(授权态、弹窗都没了),授权请求的订阅重新建立并上报就绪。 */
function rebuildRenderer(): void {
  _resetAgentAuthForTest();
  shown = 0;
  markAgentAuthRendererReady(WINDOW_ID);
}
/** 主窗 Cmd+R 的前半段:main 收到主框架非同文档导航,旧文档(连同它的授权态、弹窗、IPC 订阅)没了,新文档还在加载。 */
function startReload(): void {
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: 'file:///renderer/index.html',
  });
  _resetAgentAuthForTest();
  shown = 0;
}
/** 主窗 Cmd+R:导航开始,随后 renderer 文档重建。 */
function reload(): void {
  startReload();
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
  webContents = makeRendererWebContents();
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

// 未决请求被 reload 取消后 agent 立即重试:IPC 落在加载中的文档(订阅还没建立)→ 没有可见弹窗,main 的未决请求
// 留到 5 分钟超时再进冷却,该窗口同类调用方所有域被拒约 330s。
describe('reload 窗口期(新文档尚未建立授权订阅)到达的请求', () => {
  /** 加载中的文档收不到 IPC:期间的 send 记数后丢弃。 */
  function dropSendsWhileLoading(): { sends: number; restore: () => void } {
    const original = webContents.send;
    const state = { sends: 0, restore: () => void (webContents.send = original) };
    webContents.send = () => void (state.sends += 1);
    return state;
  }
  const raw = (method = 'terminal.send_text', external = false): Promise<string> =>
    requestAgentAuth({ method, ownerWindowId: WINDOW_ID, ...(external ? { external } : {}) });

  // main 在窗口创建时就挂上跟踪(browser-window-created),不等第一个授权请求。
  beforeEach(() => {
    watchAgentAuthRenderer(electronMock.windows[0] as never);
  });

  it('窗口创建后首次加载期间(还没上报过就绪)的请求同样立刻被拒', async () => {
    startReload(); // 首次加载也是一次主框架导航
    await expect(raw()).rejects.toThrow(/reload/i);
    rebuildRenderer();
    const p = request();
    await flush();
    expect(displayed()).toBe(true);
    user('denied');
    await p;
  });

  it('审计复现:未决请求被 reload 取消 → 立即重试 → 立刻被拒(不发 IPC、不登记未决);就绪后马上可以弹窗', async () => {
    const first = request();
    await flush();
    startReload();
    expect(await first).toBe('denied');

    const loading = dropSendsWhileLoading();
    await expect(raw()).rejects.toMatchObject({
      code: 'AGENT_NOT_AUTHORIZED',
      message: expect.stringMatching(/reload/i),
    });
    expect(loading.sends).toBe(0);
    loading.restore();
    rebuildRenderer();

    // 此前:丢失的那次请求占着未决槽 5 分钟,超时后再冷却 30s,期间别的域也弹不出。
    let lockedMs = 0;
    for (; lockedMs < 400_000; lockedMs += 10_000) {
      const p = request('debug.launch');
      await flush();
      if (displayed()) break;
      await p;
      await flush(10_000);
    }
    expect(lockedMs).toBe(0);
  });

  it('窗口期被拒的不计拒绝、不进冷却:就绪后同一域立即可弹', async () => {
    startReload();
    for (let i = 0; i < 3; i += 1) await expect(raw()).rejects.toThrow(/reload/i);
    rebuildRenderer();
    const p = request();
    await flush();
    expect(displayed()).toBe(true);
    user('once');
    expect(await p).toBe('once');
  });

  it(`窗口期的重试计入速率上限:狂刷 ${PROMPT_RATE_MAX} 次以上 → 就绪后按超速拒绝,不连弹`, async () => {
    startReload();
    for (let i = 0; i < PROMPT_RATE_MAX + 5; i += 1) await expect(raw()).rejects.toThrow(/reload/i);
    rebuildRenderer();
    await expect(raw()).rejects.toThrow(/too many authorization prompts/);
    expect(displayed()).toBe(false);
  });

  it('external 调用方与窗口内 agent 同样在窗口期被拒', async () => {
    startReload();
    await expect(raw('terminal.send_text', true)).rejects.toThrow(/reload/i);
    await expect(raw('debug.launch')).rejects.toThrow(/reload/i);
  });

  it('渲染进程崩溃后、恢复前同样立刻被拒;恢复(重新上报就绪)后正常弹窗', async () => {
    const first = request();
    await flush();
    webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    _resetAgentAuthForTest();
    expect(await first).toBe('denied');
    await expect(raw()).rejects.toThrow(/reload/i);
    await flush(60_000);
    await expect(raw()).rejects.toThrow(/reload/i);

    rebuildRenderer();
    await flush(60_000); // 上面的重试计入了速率,等窗口滑过
    const p = request();
    await flush();
    expect(displayed()).toBe(true);
    user('once');
    expect(await p).toBe('once');
  });

  it('主框架仍在加载(首次加载 / 没被监听到的 reload)的窗口同样立刻被拒', async () => {
    Object.assign(webContents, { isLoadingMainFrame: () => true });
    const loading = dropSendsWhileLoading();
    await expect(raw()).rejects.toThrow(/reload/i);
    expect(loading.sends).toBe(0);
    loading.restore();
    Object.assign(webContents, { isLoadingMainFrame: () => false });
    const p = request();
    await flush();
    expect(displayed()).toBe(true);
    user('denied');
    await p;
  });

  it('别的窗口上报就绪不影响本窗口', async () => {
    startReload();
    markAgentAuthRendererReady(WINDOW_ID + 1);
    await expect(raw()).rejects.toThrow(/reload/i);
  });
});
