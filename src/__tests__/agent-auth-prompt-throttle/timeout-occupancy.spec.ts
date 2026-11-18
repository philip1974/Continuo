// 安全:只发起、不应答的授权请求不能靠轮换授权域让弹窗一直占屏;排队中没轮到显示就到期的请求不进冷却。
// 行为见同目录 README「超时」。真实 agent-auth.service + 真实 renderer store(fake timers),接法见 renderer-harness.ts。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetPendingForTest } from '../../../electron/main/services/agent-auth.service';
import { AGENT_AUTH_PROMPT_TIMEOUT_MS as TIMEOUT } from '../../../electron/shared/agent-auth-channels';
import {
  PROMPT_DENY_COOLDOWN_BASE_MS as BASE,
  PROMPT_DENY_COOLDOWN_MAX_MS as MAX,
} from '../../../electron/main/lib/prompt-throttle';
import { _resetAgentAuthForTest, useAgentAuthStore } from '@/stores/agent-auth.store';
import {
  WINDOW_ID,
  displayed,
  flush,
  makeRendererWebContents,
  request,
  user,
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

const DOMAINS = ['terminal.send_text', 'debug.launch', 'plugin.git_commit'] as const;
/** 轮换三个授权域。 */
const domain = (i: number): string => DOMAINS[i % DOMAINS.length]!;
const displayedExternal =(): boolean => useAgentAuthStore.getState().pending?.external === true;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  _resetPendingForTest();
  _resetAgentAuthForTest();
  electronMock.windows = [
    { id: WINDOW_ID, isDestroyed: () => false, webContents: makeRendererWebContents() } as { id: number },
  ];
});

afterEach(() => {
  _resetPendingForTest();
  _resetAgentAuthForTest();
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** 发起一次请求并等它无人应答到期(必须真的弹了窗)。 */
async function timeOut(method: string = DOMAINS[0], external = false): Promise<void> {
  const p = request(method, external);
  await flush();
  expect(displayed()).toBe(true);
  await flush(TIMEOUT);
  expect(await p).toBe('denied');
  expect(displayed()).toBe(false);
}

/** 这次请求是否被节流(没弹窗)。弹了则由用户按 answer 应答。 */
async function throttled(
  method: string,
  external = false,
  answer: 'once' | 'denied' = 'once',
): Promise<boolean> {
  const p = request(method, external);
  await flush();
  if (!displayed()) {
    expect(await p).toBe('THROTTLED');
    return true;
  }
  user(answer);
  await p;
  return false;
}

describe('无人应答超时:冷却按调用方记(不按授权域)', () => {
  it('审计复现:轮换三个域、只发起不应答,每 5s 重试 → 一小时内弹窗占屏不超过 65%(此前 ≈100%)', async () => {
    const HORIZON = 60 * 60_000;
    const STEP = 5_000;
    let onScreen = 0;
    let prompts = 0;
    for (let t = 0; t < HORIZON; t += STEP) {
      if (!displayed()) {
        void request(domain(prompts));
        await flush();
        if (displayed()) prompts += 1;
      }
      if (displayed()) onScreen += STEP;
      await flush(STEP);
    }
    // 300s 显示 / 30s、60s、120s、240s、300s… 冷却 → 一小时内 8 个弹窗、占屏 62.5%,稳态 50%。
    expect(onScreen / HORIZON).toBeLessThanOrEqual(0.65);
    expect(prompts).toBe(8);
  });

  it('一个域超时 → 该调用方的所有域 30s 内都不弹窗', async () => {
    await timeOut('terminal.send_text');
    for (const method of DOMAINS) expect(await throttled(method)).toBe(true);
    await flush(BASE - 1_000);
    expect(await throttled('debug.launch')).toBe(true);
    await flush(1_000);
    expect(await throttled('debug.launch')).toBe(false);
  });

  it('连续超时翻倍:30s → 60s → 120s … 封顶 5 分钟', async () => {
    let expected = BASE;
    for (let i = 0; i < 6; i += 1) {
      await timeOut(domain(i));
      await flush(expected - 1_000);
      expect(await throttled(domain(i + 1))).toBe(true);
      await flush(1_000);
      expected = Math.min(expected * 2, MAX);
    }
    expect(expected).toBe(MAX);
  });

  it('用户对弹窗作出决定(允许或拒绝)→ 连续超时计数归零', async () => {
    await timeOut();
    await flush(BASE);
    await timeOut();
    await flush(2 * BASE);
    expect(await throttled('debug.launch', false, 'once')).toBe(false);
    // 归零后再超时从 30s 起(否则是 120s)。
    await timeOut('debug.launch');
    await flush(BASE);
    expect(await throttled('debug.launch', false, 'denied')).toBe(false);
    await flush(BASE);
    await timeOut('plugin.git_commit');
    await flush(BASE);
    expect(await throttled('plugin.git_commit')).toBe(false);
  });

  it('超时仍不算拒绝:冷却过后被拒是首次拒绝的 30s', async () => {
    await timeOut();
    await flush(BASE);
    expect(await throttled(DOMAINS[0], false, 'denied')).toBe(false);
    await flush(BASE);
    expect(await throttled(DOMAINS[0])).toBe(false);
  });

  it('窗口内 agent 超时不让 external 调用方进冷却(各记各的)', async () => {
    await timeOut();
    expect(await throttled('terminal.send_text', true)).toBe(false);
  });
});

describe('排队中的请求', () => {
  it('窗口内弹窗占屏到超时,排在后面的 external 请求没轮到显示就到期 → 不进冷却,立即可再请求', async () => {
    const inWindow = request('terminal.send_text');
    const ext = request('terminal.read_output', true);
    await flush();
    expect(displayed()).toBe(true);
    expect(displayedExternal()).toBe(false);
    await flush(TIMEOUT);
    expect(await inWindow).toBe('denied');
    expect(await ext).toBe('denied');
    // external 从未显示过 → 没有冷却;窗口内的那个显示了 5 分钟 → 有冷却。
    expect(await throttled('terminal.read_output', true)).toBe(false);
    expect(await throttled('terminal.send_text')).toBe(true);
  });

  it('轮到显示并显示到超时的排队请求照常进冷却', async () => {
    const inWindow = request('terminal.send_text');
    const ext = request('terminal.read_output', true);
    await flush(100_000);
    user('once'); // 窗口内弹窗落定 → external 的弹窗接着显示
    expect(await inWindow).toBe('once');
    expect(displayedExternal()).toBe(true);
    await flush(TIMEOUT - 100_000);
    expect(await ext).toBe('denied');
    expect(await throttled('terminal.read_output', true)).toBe(true);
  });
});
