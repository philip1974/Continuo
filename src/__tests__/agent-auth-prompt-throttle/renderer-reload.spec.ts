// 安全:renderer reload(主窗 View 菜单 Cmd+R)/ 渲染进程崩溃后,main 的授权与未决弹窗随之结算。
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
/** 主框架非同文档导航**开始**(Electron 先发它,再发 will-navigate;此刻文档还没换,也可能不会换)。 */
function startNavigation(url = 'file:///renderer/index.html'): void {
  webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
}
/**
 * 主窗 Cmd+R 的前半段:主框架非同文档导航开始并**提交**(did-navigate),旧文档(连同它的授权态、弹窗、IPC 订阅)
 * 没了,新文档还在加载。
 */
function startReload(): void {
  startNavigation();
  webContents.emit('did-navigate', {}, 'file:///renderer/index.html', 200, 'OK');
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

// 「本次启动期间允许」的权威在 main:reload(main 收到导航事件)时清掉该窗口的授权,之后恢复弹窗与节流。
// (renderer 只持有界面副本;它单独丢失不影响 main 的放行判断,不再有「main 没收到事件」的纵深分支。)
describe.each([
  ['main 收到导航事件(Cmd+R)', reload],
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
  it('未决请求立即按取消结算;同窗口的新请求马上可以弹窗(不锁到无应答超时 + 冷却)', async () => {
    const first = request();
    await flush();
    expect(displayed()).toBe(true);
    reload();

    // 审计复现:此前要等无应答超时 + 30s 冷却(当时超时 5 分钟,共 330s),期间没有任何弹窗可见。
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
// 留到无应答超时再进冷却,该窗口所有域被拒约 150s(当时超时 5 分钟,约 330s)。
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

    // 此前:丢失的那次请求占着未决槽直到无应答超时,超时后再冷却 30s,期间别的域也弹不出。
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

// 导航「开始」不等于文档会换:Electron 先发 did-start-navigation 再发 will-navigate,被导航守卫拦下 / 被中止的导航
// 没有提交(did-navigate),旧文档原样留着,也不会再上报就绪。此前按「开始」置未就绪:这样一次导航之后该窗口的授权
// 请求被永久拒绝(实测 1 小时内每分钟一次请求 60/60 被拒),显示中的弹窗也在 main 侧被提前取消。
describe('未提交的主框架导航(被拦下 / 中止)不算换文档', () => {
  const raw = (method = 'terminal.send_text'): Promise<string> =>
    requestAgentAuth({ method, ownerWindowId: WINDOW_ID });

  it('did-start-navigation 之后没有 did-navigate → 之后的请求照常弹窗(不是「窗口正在重新加载」)', async () => {
    // 先正常弹一次(main 此时已在跟踪该窗口的 webContents)
    const before = raw();
    await flush();
    user('once');
    expect(await before).toBe('once');
    startNavigation('file:///renderer/index.html?dropped=1');
    for (let minute = 0; minute < 3; minute += 1) {
      const p = raw();
      await flush();
      expect(displayed()).toBe(true);
      user('once');
      expect(await p).toBe('once');
      await flush(60_000);
    }
  });

  it('显示中的弹窗不被未提交的导航取消:用户的应答照常生效', async () => {
    const first = request();
    await flush();
    expect(displayed()).toBe(true);
    startNavigation('https://example.com/dropped-link');
    await flush();
    expect(displayed()).toBe(true);
    user('once');
    expect(await first).toBe('once');
  });

  it('未提交的导航不清「本次启动期间允许」(旧文档与它的界面副本都还在)', async () => {
    await grantSession();
    startNavigation();
    // 已授权域:并发请求全部秒回 session,不走单飞
    expect(await Promise.all([request(), request(), request()])).toEqual(['session', 'session', 'session']);
  });

  it('导航开始到提交之间(主框架加载中)的请求被拒;提交后到就绪前也被拒;就绪后恢复', async () => {
    reload();
    let loading = true;
    Object.assign(webContents, { isLoadingMainFrame: () => loading });
    startNavigation();
    await expect(raw()).rejects.toThrow(/reload/i);
    webContents.emit('did-navigate', {}, 'file:///renderer/index.html', 200, 'OK');
    _resetAgentAuthForTest();
    loading = false; // did-finish-load 不算就绪:订阅建立在其后
    await expect(raw()).rejects.toThrow(/reload/i);
    rebuildRenderer();
    const p = request('debug.launch');
    await flush();
    expect(displayed()).toBe(true);
    user('denied');
    await p;
  });

  it('主框架加载失败(did-fail-load,提交的是错误页)→ 未就绪;子框架加载失败不算', async () => {
    reload();
    webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://x.invalid/', false);
    const p = request();
    await flush();
    expect(displayed()).toBe(true);
    user('once');
    expect(await p).toBe('once');

    webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///renderer/index.html', true);
    await expect(raw('debug.launch')).rejects.toThrow(/reload/i);
  });

  it('主框架 did-fail-load 的 ERR_ABORTED(-3)不算换文档:新文档加载中又 reload → 随后的提交 + 就绪照常恢复', async () => {
    // 真机:文档已提交但仍在加载时再 reload,Electron 发 did-fail-load(-3, isMainFrame) → did-navigate → 就绪。
    startReload();
    webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///renderer/index.html', true);
    webContents.emit('did-navigate', {}, 'file:///renderer/index.html', 200, 'OK');
    rebuildRenderer();
    const p = request();
    await flush();
    expect(displayed()).toBe(true);
    user('once');
    expect(await p).toBe('once');
  });

  it('就绪之后才来的主框架 ERR_ABORTED(-3,如主进程对已提交文档调 wc.stop())→ 窗口仍就绪,显示中的弹窗不被取消', async () => {
    reload();
    const first = request();
    await flush();
    expect(displayed()).toBe(true);
    webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///renderer/index.html', true);
    await flush();
    user('once');
    expect(await first).toBe('once');
    // 此前:置未就绪且不会再有 READY → 该窗口的授权请求被永久拒绝。
    const p = request('debug.launch');
    await flush();
    expect(displayed()).toBe(true);
    user('once');
    expect(await p).toBe('once');
  });

  it('窗口销毁(destroyed)→ 未决请求立即结算', async () => {
    const first = request();
    await flush();
    webContents.emit('destroyed');
    expect(await first).toBe('denied');
  });
});
