// 文件夹授权弹窗的无应答超时从开始显示起算(排队不计),排队另有兜底上限。行为见同目录 README。
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { registerPluginFsHandlers } from '../../../electron/main/services/plugin-fs.service';
import { withTrustedFrameGate } from '../../../electron/main/safe-handle';
import { StubIpcMain, makeFakeEvent } from '../sdk-contract/integration/make-stub-ipc';
import { flushMacrotasks } from '../_helpers/async';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') }, BrowserWindow: {} }));

const C = PLUGIN_FS_CHANNELS;
const TTL_MS = 5 * 60_000;
const QUEUE_MAX_MS = 10 * 60_000;

let root: string;
let ipc: StubIpcMain;
let correlator: ScopeRequestCorrelator;
const event = makeFakeEvent({ id: 1 });
const otherWindow = makeFakeEvent({ id: 2 });
const untrustedFrame = makeFakeEvent({ id: 1, senderFrame: { url: 'https://evil.example/' } });
const tokens = new Map<string, string>();

type SentCall = [string, { requestId: string }];
const sentIds = (channel: string): string[] =>
  (event.sender.send.mock.calls as SentCall[]).filter(([c]) => c === channel).map(([, p]) => p.requestId);

interface Fired {
  readonly requestId: string;
  readonly outcome: () => unknown;
}

/** 发起 requestScope 并等到弹窗发往 renderer;outcome() 读当前结算结果(未结算 → 'pending')。 */
async function fire(pluginId: string, dir: string): Promise<Fired> {
  const before = sentIds(C.SCOPE_REQUEST).length;
  let outcome: unknown = 'pending';
  ipc.invokeWithEvent(event, C.REQUEST_SCOPE, tokens.get(pluginId), [{ path: dir, mode: 'r' }]).then(
    (r) => (outcome = r),
    (e: Error) => (outcome = e.message),
  );
  while (sentIds(C.SCOPE_REQUEST).length === before) await flushMacrotasks(1, 'immediate');
  return { requestId: sentIds(C.SCOPE_REQUEST)[before]!, outcome: () => outcome };
}

const shown = (requestId: string, ev = event): Promise<unknown> =>
  ipc.invokeWithEvent(ev, C.SCOPE_REQUEST_SHOWN, requestId);
const decide = (requestId: string, decision: 'grant' | 'deny'): Promise<unknown> =>
  ipc.invokeWithEvent(event, C.SCOPE_DECISION, requestId, decision);
const settle = (): Promise<void> => flushMacrotasks(5, 'immediate');

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'scope-shown-')));
  for (const d of ['a', 'b']) await mkdir(join(root, d));
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  event.sender.send.mockReset();
  tokens.clear();
  ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  correlator = new ScopeRequestCorrelator();
  registerPluginFsHandlers(withTrustedFrameGate(ipc as never), {
    identityRegistry: identity,
    pathScopeRegistry: new PathScopeRegistry(identity),
    correlator,
  });
  for (const id of ['p', 'q']) {
    const r = (await ipc.invokeWithEvent(event, C.REGISTER_PLUGIN, id)) as { token: string };
    tokens.set(id, r.token);
  }
});

afterEach(async () => {
  correlator.dispose();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe('排队中的请求不因前一个弹窗停留久而过期', () => {
  it('A 显示 4 分 50 秒后应答 → 排在后面的 B 轮到显示后仍有完整 5 分钟', async () => {
    const a = await fire('p', join(root, 'a'));
    const b = await fire('q', join(root, 'b'));
    await shown(a.requestId);
    vi.advanceTimersByTime(290_000);
    await decide(a.requestId, 'grant');
    await settle();
    expect(a.outcome()).toBe('grant');

    await shown(b.requestId);
    vi.advanceTimersByTime(TTL_MS - 1_000);
    await settle();
    expect(b.outcome()).toBe('pending');
    await decide(b.requestId, 'deny');
    await settle();
    expect(b.outcome()).toBe('deny');
    expect(sentIds(C.SCOPE_REQUEST_CANCELLED)).toEqual([]);
  });

  it('A 停留超过 5 分钟:只有 A 过期,排队中的 B 不受影响', async () => {
    const a = await fire('p', join(root, 'a'));
    const b = await fire('q', join(root, 'b'));
    await shown(a.requestId);
    vi.advanceTimersByTime(TTL_MS);
    await settle();
    expect(a.outcome()).toBe('request expired');
    expect(sentIds(C.SCOPE_REQUEST_CANCELLED)).toEqual([a.requestId]);
    expect(b.outcome()).toBe('pending');
  });
});

describe('显示后超时照常', () => {
  it('显示满 5 分钟无应答 → 插件收到 request expired,renderer 收到撤弹窗通知;迟到的决定被拒收', async () => {
    const a = await fire('p', join(root, 'a'));
    await shown(a.requestId);
    vi.advanceTimersByTime(TTL_MS - 1);
    await settle();
    expect(a.outcome()).toBe('pending');
    vi.advanceTimersByTime(1);
    await settle();
    expect(a.outcome()).toBe('request expired');
    expect(sentIds(C.SCOPE_REQUEST_CANCELLED)).toEqual([a.requestId]);
    await expect(decide(a.requestId, 'grant')).rejects.toThrow('unknown requestId');
  });

  it('重复回报显示不能续期', async () => {
    const a = await fire('p', join(root, 'a'));
    await shown(a.requestId);
    vi.advanceTimersByTime(TTL_MS - 1_000);
    await shown(a.requestId);
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(a.outcome()).toBe('request expired');
  });
});

describe('排队兜底上限', () => {
  it('一直没回报显示 → 5 分钟时仍在,10 分钟到点按超时收口并撤弹窗', async () => {
    const a = await fire('p', join(root, 'a'));
    vi.advanceTimersByTime(TTL_MS + 60_000);
    await settle();
    expect(a.outcome()).toBe('pending');
    vi.advanceTimersByTime(QUEUE_MAX_MS - TTL_MS - 60_000);
    await settle();
    expect(a.outcome()).toBe('request expired');
    expect(sentIds(C.SCOPE_REQUEST_CANCELLED)).toEqual([a.requestId]);
  });
});

describe('只有本窗口的受信 frame 能标记显示', () => {
  it('别的窗口回报显示无效:请求仍按排队计时,不会在 5 分钟时过期', async () => {
    const a = await fire('p', join(root, 'a'));
    await shown(a.requestId, otherWindow);
    vi.advanceTimersByTime(TTL_MS + 60_000);
    await settle();
    expect(a.outcome()).toBe('pending');
    // 本窗口随后回报才开始计显示超时。
    await shown(a.requestId);
    vi.advanceTimersByTime(TTL_MS - 1_000);
    await settle();
    expect(a.outcome()).toBe('pending');
  });

  it('不受信 frame 的回报被拒绝(DENIED),不标记', async () => {
    const a = await fire('p', join(root, 'a'));
    await expect(shown(a.requestId, untrustedFrame)).rejects.toThrow('sender frame is not trusted');
    vi.advanceTimersByTime(TTL_MS + 60_000);
    await settle();
    expect(a.outcome()).toBe('pending');
  });

  it('畸形 requestId → BAD_INPUT', async () => {
    for (const bad of [undefined, 7, '', 'x'.repeat(10_000), { requestId: 'a' }]) {
      await expect(ipc.invokeWithEvent(event, C.SCOPE_REQUEST_SHOWN, bad)).rejects.toThrow(
        'invalid scope-request-shown requestId',
      );
    }
  });
});
