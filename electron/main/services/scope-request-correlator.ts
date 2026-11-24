import { randomUUID } from 'node:crypto';
import { ScopeRequestTimeoutError } from '../../shared/plugin-fs-contract';

interface PendingEntry {
  token: string;
  webContentsId: number;
  /** renderer 是否已回报该请求的弹窗开始显示(markShown)。 */
  shown: boolean;
  /** 排队中 = 排队兜底上限;显示中 = 无应答超时。到点按超时收口(reject 'request expired')。 */
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: 'grant' | 'deny') => void;
  reject: (err: ScopeRequestTimeoutError) => void;
}

export interface CreateRequestResult {
  requestId: string;
  promise: Promise<'grant' | 'deny'>;
}

// 无应答超时从弹窗**开始显示**起算(renderer 的 fs-scope 弹窗是 FIFO 队列、一次只显示一个、自身不计时,显示队首时经
// SCOPE_REQUEST_SHOWN 回报 markShown)。此前从创建起算:两个插件几乎同时 requestScope,用户在 A 的弹窗停 4 分 50 秒
// 再应答,B 只显示约 10 秒即被收口。与 agent-auth.service 的 markDisplayed 同一模式。到期按超时收口,并经
// SCOPE_REQUEST_CANCELLED 通知 renderer 撤弹窗。
// 计时用 setTimeout(与 agent-auth 一致):libuv 定时器走单调时钟,不计入系统睡眠;此前按 Date.now 比较 + 每分钟扫描,
// 弹窗开着合盖超过 5 分钟,唤醒后一分钟内就被清掉。
const DEFAULT_TTL_MS = 300_000;
// 排队兜底(与 AGENT_AUTH_QUEUE_MAX_MS 同值):这么久仍没轮到显示(前面的弹窗一直轮不完 / renderer 没回报)→ 同样
// 按超时收口,请求不会无限挂起。
const DEFAULT_QUEUE_MAX_MS = 600_000;
/** cancelByToken 的 reject 原因(request-scope handler 据此按 deny 静默收口)。 */
export const SCOPE_REQUEST_PLUGIN_UNREGISTERED = 'plugin unregistered';
// 边界(E227):未决 scope 请求数量上限。单次 request-scope 的 scopes 已限,但插件可连续 spam 大量未决
// 请求 —— 每个在 pending Map 驻留至 resolve / 超时,且 renderer 弹窗队列随之线性增长 → 内存/弹窗放大。
// 全局 + per-webContents 双闸,超限由调用方按终态 deny 收口(不入 pending、不弹窗)。
const MAX_PENDING_SCOPE_REQUESTS = 256; // 全局未决上限(远超任何正常并发授权)
const MAX_PENDING_PER_WEBCONTENTS = 64; // 单窗口未决上限

export class ScopeRequestCorrelator {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly ttlMs: number;
  private readonly queueMaxMs: number;

  constructor(opts?: { ttlMs?: number; queueMaxMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.queueMaxMs = opts?.queueMaxMs ?? DEFAULT_QUEUE_MAX_MS;
  }

  /**
   * 边界(E227):是否可再接受一个未决 scope 请求(全局 + per-webContents 双闸)。调用方在 createRequest +
   * 弹窗前检查,false → 按终态 deny 收口(不入 pending、不向 renderer 发弹窗),防插件 spam 让 pending /
   * renderer 弹窗队列线性增长。pending Map 已封顶后此遍历 O(≤MAX_PENDING_SCOPE_REQUESTS)。
   */
  canAccept(webContentsId: number): boolean {
    if (this.pending.size >= MAX_PENDING_SCOPE_REQUESTS) return false;
    let n = 0;
    for (const e of this.pending.values()) {
      if (e.webContentsId === webContentsId) {
        n += 1;
        if (n >= MAX_PENDING_PER_WEBCONTENTS) return false;
      }
    }
    return true;
  }

  createRequest(
    token: string,
    webContentsId: number,
  ): CreateRequestResult {
    const requestId = randomUUID();
    let resolveFn: PendingEntry['resolve'];
    let rejectFn: PendingEntry['reject'];
    const promise = new Promise<'grant' | 'deny'>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    this.pending.set(requestId, {
      token,
      webContentsId,
      shown: false,
      timer: this.expireAfter(requestId, this.queueMaxMs),
      resolve: resolveFn!,
      reject: rejectFn!,
    });
    return { requestId, promise };
  }

  /**
   * renderer 回报该请求的弹窗开始显示:从此刻起计无应答超时(替换排队兜底计时)。只认发给该 webContents 的请求,
   * 且只生效一次(重复回报不能续期)。未知 / 不属于该 webContents / 已标记 → false,不改任何状态。
   */
  markShown(requestId: string, fromWebContentsId: number): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.webContentsId !== fromWebContentsId || entry.shown) return false;
    entry.shown = true;
    clearTimeout(entry.timer);
    entry.timer = this.expireAfter(requestId, this.ttlMs);
    return true;
  }

  private expireAfter(requestId: string, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const entry = this.pending.get(requestId);
      if (!entry) return;
      this.pending.delete(requestId);
      entry.reject(new ScopeRequestTimeoutError('request expired', requestId));
    }, ms);
    const maybeUnref = timer as { unref?: () => void };
    if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
    return timer;
  }

  /**
   * Resolve a pending request. One-shot: the entry is dropped, so subsequent calls throw
   * 'unknown requestId'. Throws if requestId unknown (含已超时收口) or sender mismatch.
   */
  resolve(
    requestId: string,
    decision: 'grant' | 'deny',
    fromWebContentsId: number,
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) throw new ScopeRequestTimeoutError('unknown requestId', requestId);
    if (entry.webContentsId !== fromWebContentsId) {
      throw new ScopeRequestTimeoutError('wrong webContents', requestId);
    }
    clearTimeout(entry.timer);
    entry.resolve(decision);
    this.pending.delete(requestId);
  }

  /**
   * Reject + drop every pending request originated by a given webContents.
   * Call when the owning window is closed/crashed: the awaiting renderer died
   * with it, so the host-side `await promise` would otherwise hang in the
   * `pending` Map until the timeout. Mirrors `cancelAgentAuthByWindow`
   * (agent-auth) / `broker.cancelByWindow` (hook-bridge) — the parallel
   * "window closed but waiter still pending" cleanup channels. Returns count.
   */
  cancelBySender(webContentsId: number): number {
    let n = 0;
    for (const [requestId, entry] of this.pending) {
      if (entry.webContentsId !== webContentsId) continue;
      clearTimeout(entry.timer);
      entry.reject(new ScopeRequestTimeoutError('window closed', requestId));
      this.pending.delete(requestId);
      n++;
    }
    return n;
  }

  /**
   * 插件实例被注销(卸载 / 禁用 / reload)时 reject 并丢弃它的未决请求:该实例已不在,用户的决定无处落地
   * (grant 也会因 token 失效被丢弃),而请求留在 pending 会一直占着该插件的单飞名额直到用户应答或超时。
   */
  cancelByToken(token: string): number {
    let n = 0;
    for (const [requestId, entry] of this.pending) {
      if (entry.token !== token) continue;
      clearTimeout(entry.timer);
      entry.reject(new ScopeRequestTimeoutError(SCOPE_REQUEST_PLUGIN_UNREGISTERED, requestId));
      this.pending.delete(requestId);
      n++;
    }
    return n;
  }

  /** Stops all pending timers. Call on host shutdown. Used in tests for cleanup. */
  dispose(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
  }

  /** Test-only inspect. */
  _peek(requestId: string): PendingEntry | undefined {
    return this.pending.get(requestId);
  }
}

export const DEFAULT_TTL_MS_FOR_TEST = DEFAULT_TTL_MS;
export const DEFAULT_QUEUE_MAX_MS_FOR_TEST = DEFAULT_QUEUE_MAX_MS;
