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

describe('无人应答超时时长', () => {
  it('弹窗 120s 无人应答 → main 结算为拒绝,renderer 同时关掉弹窗', async () => {
    expect(TIMEOUT).toBe(120_000);
    const p = request();
    await flush(120_000 - 1);
    expect(displayed()).toBe(true);
    await flush(1);
    expect(await p).toBe('denied');
    expect(displayed()).toBe(false);
  });
});

describe('无人应答超时:冷却不按授权域记', () => {
  it('审计复现:轮换三个域、只发起不应答,每 5s 重试 → 一小时内弹窗占屏不超过 40%(此前 ≈100%)', async () => {
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
    // 120s 显示 / 30s、60s、120s、240s、300s… 冷却 → 一小时内 11 个弹窗、占屏 36.7%,稳态 120/420 ≈ 28.6%。
    // (超时 5 分钟时:8 个弹窗、62.5%。)
    expect(onScreen / HORIZON).toBeLessThanOrEqual(0.4);
    expect(prompts).toBe(11);
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
});

describe('无人应答超时:冷却按窗口记(窗口内 agent 与 external 共用)', () => {
  it('审计复现:窗口内与 external 两个身份交替发起、只发起不应答,每 5s 重试 → 一小时内弹窗占屏不超过 40%(此前 100%)', async () => {
    const HORIZON = 60 * 60_000;
    const STEP = 5_000;
    let onScreen = 0;
    let prompts = 0;
    for (let t = 0; t < HORIZON; t += STEP) {
      // 轮流打头:先用一个身份,它在冷却 / 被拒就换另一个。external 不能请求插件域(renderer 直接拒),只轮换前两个域。
      for (const external of prompts % 2 === 0 ? [false, true] : [true, false]) {
        if (displayed()) break;
        void request(DOMAINS[prompts % 2]!, external);
        await flush();
        if (displayed()) prompts += 1;
      }
      if (displayed()) onScreen += STEP;
      await flush(STEP);
    }
    // 超时冷却按 subject 记时一个身份冷却、另一个顶上:超时 5 分钟 12 个弹窗、占屏 100%(超时 2 分钟 20 个、
    // 66.7%)。按窗口记后与单身份相同:11 个弹窗、占屏 36.7%(超时 5 分钟时 8 个、62.5%)。
    expect(onScreen / HORIZON).toBeLessThanOrEqual(0.4);
    expect(prompts).toBe(11);
  });

  it('窗口内 agent 超时 → 同窗口的 external 调用方也进冷却;反之亦然', async () => {
    await timeOut('terminal.send_text');
    expect(await throttled('terminal.read_output', true)).toBe(true);
    await flush(BASE);
    await timeOut('terminal.read_output', true);
    expect(await throttled('debug.launch')).toBe(true);
  });

  it('连续超时计数按窗口合并:窗口内超时后 external 再超时,冷却是第二级的 60s', async () => {
    await timeOut('terminal.send_text');
    await flush(BASE);
    await timeOut('terminal.read_output', true);
    await flush(2 * BASE - 1_000);
    expect(await throttled('terminal.send_text')).toBe(true);
    expect(await throttled('terminal.read_output', true)).toBe(true);
    await flush(1_000);
    expect(await throttled('terminal.send_text')).toBe(false);
  });

  it('用户在任一调用方的弹窗上作出决定 → 该窗口的连续超时计数归零', async () => {
    await timeOut('terminal.send_text', true);
    await flush(BASE);
    await timeOut('terminal.read_output', true);
    await flush(2 * BASE);
    // external 连续超时 2 次;用户对窗口内 agent 的弹窗点了「仅本次」。
    expect(await throttled('debug.launch', false, 'once')).toBe(false);
    // 归零后 external 再超时从 30s 起(否则是 120s)。
    await timeOut('terminal.read_output', true);
    await flush(BASE);
    expect(await throttled('terminal.read_output', true)).toBe(false);
  });

  it('拒绝冷却仍按调用方:external 被拒不影响窗口内 agent(同一域)', async () => {
    expect(await throttled('terminal.send_text', true, 'denied')).toBe(false);
    expect(await throttled('terminal.send_text', true)).toBe(true);
    expect(await throttled('terminal.send_text')).toBe(false);
  });
});

describe('排队中的请求', () => {
  it('窗口内弹窗占屏到超时,排在后面的 external 请求没轮到显示就到期 → 不另记超时', async () => {
    const inWindow = request('terminal.send_text');
    const ext = request('terminal.read_output', true);
    await flush();
    expect(displayed()).toBe(true);
    expect(displayedExternal()).toBe(false);
    await flush(TIMEOUT);
    expect(await inWindow).toBe('denied');
    expect(await ext).toBe('denied');
    // 窗口内的那个显示到超时 → 该窗口(含 external)进 30s 冷却;external 从未显示过 → 不另记一次超时
    // (否则连续超时计数为 2、冷却 60s)。
    expect(await throttled('terminal.read_output', true)).toBe(true);
    expect(await throttled('terminal.send_text')).toBe(true);
    await flush(BASE);
    expect(await throttled('terminal.read_output', true)).toBe(false);
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
