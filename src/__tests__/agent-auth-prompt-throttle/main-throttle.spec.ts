// 安全:agent 授权弹窗被拒后有冷却 / 退避 / 单飞 / 速率上限,被提示注入的 agent 不能循环弹窗诱导误点。
// 行为见同目录 README。真实 agent-auth.service + 真实节流,只 mock electron 窗口与终端服务。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPendingForTest,
  answerAgentAuthRequest,
  cancelAgentAuthByWindow,
  requestAgentAuth,
  revokeAndKillAgentSessions,
} from '../../../electron/main/services/agent-auth.service';
import {
  AGENT_AUTH_PROMPT_TIMEOUT_MS,
  type AgentAuthDecision,
  type AgentAuthRequestPayload,
} from '../../../electron/shared/agent-auth-channels';
import {
  PROMPT_DENY_COOLDOWN_BASE_MS as BASE,
  PROMPT_DENY_COOLDOWN_MAX_MS as MAX,
  PROMPT_RATE_MAX,
  PROMPT_RATE_WINDOW_MS,
} from '../../../electron/main/lib/prompt-throttle';
import { ERROR_CODES } from '../../../electron/shared/error-codes';

type FakeWindow = {
  id: number;
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn>; getURL: () => string };
};

const electronMock = vi.hoisted(() => ({ windows: [] as FakeWindow[] }));

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

function makeWin(id: number): FakeWindow {
  return {
    id,
    isDestroyed: () => false,
    webContents: { send: vi.fn(), getURL: () => 'file:///renderer/index.html' },
  };
}

let win: FakeWindow;
const prompts = (w: FakeWindow = win): number => w.webContents.send.mock.calls.length;
const lastRequestId = (w: FakeWindow = win): string =>
  (w.webContents.send.mock.calls.at(-1)![1] as AgentAuthRequestPayload).requestId;

interface Req {
  readonly method?: string;
  readonly external?: boolean;
  readonly windowId?: number;
}
const request = (r: Req = {}): Promise<AgentAuthDecision> =>
  requestAgentAuth({
    method: r.method ?? 'terminal.send_text',
    ownerWindowId: r.windowId ?? 1,
    ...(r.external ? { external: true } : {}),
  });

/** 发一次请求并让用户应答(必须真的弹了窗)。 */
async function ask(decision: AgentAuthDecision, r: Req = {}): Promise<AgentAuthDecision> {
  const w = electronMock.windows.find((x) => x.id === (r.windowId ?? 1))!;
  const before = prompts(w);
  const p = request(r);
  expect(prompts(w)).toBe(before + 1);
  answerAgentAuthRequest(lastRequestId(w), decision, w.id);
  return p;
}

/** 请求被节流:不发 IPC,抛 AGENT_NOT_AUTHORIZED 且消息匹配。 */
async function expectThrottled(r: Req, message: RegExp): Promise<void> {
  const before = electronMock.windows.map((w) => prompts(w));
  await expect(request(r)).rejects.toMatchObject({
    code: ERROR_CODES.AGENT_NOT_AUTHORIZED,
    message: expect.stringMatching(message),
  });
  expect(electronMock.windows.map((w) => prompts(w))).toEqual(before);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  win = makeWin(1);
  electronMock.windows = [win];
  _resetPendingForTest();
});

afterEach(() => {
  _resetPendingForTest();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('agent 授权弹窗:拒绝冷却与退避', () => {
  it('审计复现:顺序 500 次请求、每次被拒 → 只弹 1 次,其余不发 IPC 并说明多久内不再询问', async () => {
    await expect(ask('denied')).resolves.toBe('denied');
    for (let i = 0; i < 499; i += 1) {
      await expectThrottled({}, /user denied.*not ask again for 30s/);
    }
    expect(prompts()).toBe(1);
  });

  it('冷却消息里的秒数是剩余时间(向上取整)', async () => {
    await ask('denied');
    vi.advanceTimersByTime(12_500);
    await expectThrottled({}, /not ask again for 18s/);
  });

  it('冷却到期可再弹;同一域连续被拒 30s → 60s → 120s … 封顶 5 分钟', async () => {
    // 换域会触发调用方级退避(另测);这里只打同一个域,key 冷却始终 ≥ 调用方级退避。
    let expected = BASE;
    for (let i = 0; i < 6; i += 1) {
      await ask('denied');
      vi.advanceTimersByTime(expected - 1);
      await expectThrottled({}, /not ask again for 1s/);
      vi.advanceTimersByTime(1);
      expected = Math.min(expected * 2, MAX);
    }
    expect(expected).toBe(MAX);
    expect(prompts()).toBe(6);
  });

  it('冷却按授权域记:terminal 被拒不挡 debug;同域的不同 method 一样被挡', async () => {
    await ask('denied', { method: 'terminal.send_text' });
    await expectThrottled({ method: 'terminal.create_session' }, /not ask again/);
    await expect(ask('once', { method: 'debug.launch' })).resolves.toBe('once');
  });

  it('轮换域:同一调用方连续 3 次被拒(不论域)→ 该调用方所有域进入退避', async () => {
    await ask('denied', { method: 'terminal.send_text' });
    await ask('denied', { method: 'debug.launch' });
    await ask('denied', { method: 'plugin.git_commit' });
    expect(prompts()).toBe(3);
    // 三个域都在各自冷却里;冷却(30s)过后 key 冷却已到期,但调用方级退避同样是 30s 起 → 再拒一次翻倍。
    vi.advanceTimersByTime(BASE);
    await ask('denied', { method: 'terminal.send_text' });
    // terminal 自己 60s;debug 的 key 冷却已到期,但调用方级退避(第 4 次连拒 → 60s)挡住。
    vi.advanceTimersByTime(BASE);
    await expectThrottled({ method: 'debug.launch' }, /not ask again for 30s/);
  });

  it('授予(once)不计为拒绝:之后的请求照常弹窗;并清除该域的拒绝记录', async () => {
    await ask('denied');
    vi.advanceTimersByTime(BASE);
    await expect(ask('once')).resolves.toBe('once');
    await expect(ask('once')).resolves.toBe('once');
    // 拒绝记录已清 → 再被拒从 30s 起,而不是 60s。
    await ask('denied');
    vi.advanceTimersByTime(BASE);
    await expect(ask('once')).resolves.toBe('once');
  });

  it('超时(用户不理会)不计为拒绝、不升级拒绝退避,但进入 30s 冷却', async () => {
    const p = request();
    expect(prompts()).toBe(1);
    await vi.advanceTimersByTimeAsync(AGENT_AUTH_PROMPT_TIMEOUT_MS);
    await expect(p).resolves.toBe('denied');
    await expectThrottled({}, /not ask again for 30s/);
    vi.advanceTimersByTime(BASE);
    // 超时没有升级:这次被拒仍是首次拒绝的 30s。
    await ask('denied');
    vi.advanceTimersByTime(BASE);
    await expect(ask('once')).resolves.toBe('once');
  });

  it('窗口关闭 / 撤销结算的请求不计为拒绝', async () => {
    const p1 = request();
    cancelAgentAuthByWindow(1);
    await expect(p1).resolves.toBe('denied');
    const p2 = request();
    expect(prompts()).toBe(2);
    revokeAndKillAgentSessions();
    await expect(p2).resolves.toBe('denied');
    await expect(ask('once')).resolves.toBe('once');
  });

  it(`速率上限:同一调用方 ${PROMPT_RATE_WINDOW_MS / 1000}s 内最多 ${PROMPT_RATE_MAX} 个弹窗(即使每次都点「仅本次」)`, async () => {
    for (let i = 0; i < PROMPT_RATE_MAX; i += 1) await ask('once');
    await expectThrottled({}, /too many authorization prompts.*60s/);
    vi.advanceTimersByTime(PROMPT_RATE_WINDOW_MS);
    await expect(ask('once')).resolves.toBe('once');
  });
});

describe('agent 授权弹窗:单飞与「本次启动期间允许」', () => {
  it('同一调用方已有未决弹窗 → 新请求直接拒(不发 IPC、不计拒绝)', async () => {
    const p = request();
    await expectThrottled({ method: 'debug.launch' }, /already waiting/);
    await expectThrottled({}, /already waiting/);
    answerAgentAuthRequest(lastRequestId(), 'once', 1);
    await expect(p).resolves.toBe('once');
    // 未决期间被拒的那两次不算用户拒绝 → 没有冷却。
    await expect(ask('once')).resolves.toBe('once');
    await expect(ask('once', { method: 'debug.launch' })).resolves.toBe('once');
  });

  it('用户选了「本次启动期间允许」后,该域的并发请求全部转发给 renderer(不单飞、不计速率)', async () => {
    await expect(ask('session')).resolves.toBe('session');
    const ps = Array.from({ length: PROMPT_RATE_MAX * 3 }, () => request());
    expect(prompts()).toBe(1 + PROMPT_RATE_MAX * 3);
    for (const [, payload] of win.webContents.send.mock.calls.slice(1)) {
      answerAgentAuthRequest((payload as AgentAuthRequestPayload).requestId, 'session', 1);
    }
    await expect(Promise.all(ps)).resolves.toEqual(ps.map(() => 'session'));
    // 只对被授予的域:debug 仍单飞。
    const d = request({ method: 'debug.launch' });
    await expectThrottled({ method: 'debug.launch' }, /already waiting/);
    answerAgentAuthRequest(lastRequestId(), 'denied', 1);
    await d;
  });

  it('撤销后「本次启动期间允许」失效:该域恢复单飞与冷却', async () => {
    await ask('session');
    revokeAndKillAgentSessions();
    const p = request();
    await expectThrottled({}, /already waiting/);
    answerAgentAuthRequest(lastRequestId(), 'denied', 1);
    await p;
    await expectThrottled({}, /not ask again for 30s/);
  });

  it('纵深:镜像过期(renderer 丢了授权态而 main 没收到事件)→ 按镜像放行的请求被拒即恢复节流,这次拒绝照常计冷却', async () => {
    await ask('session');
    // 对「已授权」域的请求真的弹了窗并被用户拒绝。
    await expect(ask('denied')).resolves.toBe('denied');
    await expectThrottled({}, /not ask again for 30s/);
    vi.advanceTimersByTime(BASE);
    // 镜像已清 → 恢复单飞。
    const p = request();
    await expectThrottled({}, /already waiting/);
    answerAgentAuthRequest(lastRequestId(), 'once', 1);
    await p;
  });

  it('纵深:镜像过期时并发的同域请求只记一次拒绝(其余是 renderer 因槽被占自动拒的)', async () => {
    await ask('session');
    const ps = Array.from({ length: 5 }, () => request());
    for (const [, payload] of win.webContents.send.mock.calls.slice(1)) {
      answerAgentAuthRequest((payload as AgentAuthRequestPayload).requestId, 'denied', 1);
    }
    await Promise.all(ps);
    // 一次拒绝 → 30s;若 5 次都记,调用方级退避会到 120s。
    await expectThrottled({}, /not ask again for 30s/);
    vi.advanceTimersByTime(BASE);
    await expect(ask('once')).resolves.toBe('once');
  });
});

describe('agent 授权弹窗:external 调用方与窗口内 agent 互不占用', () => {
  it('external 弹窗未决 / 连续被拒进入冷却,都不影响窗口内 agent 的首次请求', async () => {
    const ext = request({ external: true });
    // external 占着它自己的槽;窗口内 agent 的请求照常发给 renderer。
    const inWindow = request();
    expect(prompts()).toBe(2);
    const [extId, winId] = win.webContents.send.mock.calls.map(
      ([, payload]) => (payload as AgentAuthRequestPayload).requestId,
    );
    answerAgentAuthRequest(extId!, 'denied', 1);
    await expect(ext).resolves.toBe('denied');
    answerAgentAuthRequest(winId!, 'once', 1);
    await expect(inWindow).resolves.toBe('once');

    await expectThrottled({ external: true }, /not ask again for 30s/);
    await expect(ask('once')).resolves.toBe('once');
  });

  it('反向同理:窗口内 agent 被拒进入冷却不影响 external;不同窗口互不影响', async () => {
    const win2 = makeWin(2);
    electronMock.windows = [win, win2];
    await ask('denied');
    await expect(ask('once', { external: true })).resolves.toBe('once');
    await expect(ask('once', { windowId: 2 })).resolves.toBe('once');
    await expectThrottled({}, /not ask again for 30s/);
  });

  it('external 的「本次启动期间允许」不解除窗口内 agent 的单飞(反之亦然)', async () => {
    await ask('session', { external: true });
    const p = request();
    await expectThrottled({}, /already waiting/);
    answerAgentAuthRequest(lastRequestId(), 'once', 1);
    await p;
  });
});
