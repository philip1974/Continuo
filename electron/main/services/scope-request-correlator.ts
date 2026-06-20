import { randomUUID } from 'node:crypto';
import {
  ScopeRequestTimeoutError,
  type PathScope,
} from '../../../src/plugins/types';

interface PendingEntry {
  token: string;
  scopes: readonly PathScope[];
  webContentsId: number;
  expiresAt: number;
  resolve: (decision: 'grant' | 'deny') => void;
  reject: (err: ScopeRequestTimeoutError) => void;
  resolved: boolean;
}

export interface CreateRequestResult {
  requestId: string;
  promise: Promise<'grant' | 'deny'>;
}

const DEFAULT_TTL_MS = 300_000;
const GC_INTERVAL_MS = 60_000;
const PING_REFRESH_MS = 300_000;

export class ScopeRequestCorrelator {
  private readonly pending = new Map<string, PendingEntry>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private _ttlMs = DEFAULT_TTL_MS;

  constructor(opts?: { ttlMs?: number; gcIntervalMs?: number }) {
    const gcInterval = opts?.gcIntervalMs ?? GC_INTERVAL_MS;
    this.gcTimer = setInterval(() => this._sweep(), gcInterval);
    const maybeUnref = this.gcTimer as { unref?: () => void };
    if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
    if (opts?.ttlMs !== undefined) {
      this._ttlMs = opts.ttlMs;
    }
  }

  createRequest(
    token: string,
    scopes: readonly PathScope[],
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
      scopes,
      webContentsId,
      expiresAt: Date.now() + this._ttlMs,
      resolve: resolveFn!,
      reject: rejectFn!,
      resolved: false,
    });
    return { requestId, promise };
  }

  /**
   * Resolve a pending request. One-shot: subsequent calls throw.
   * Throws if requestId unknown, sender mismatch, expired, or already resolved.
   */
  resolve(
    requestId: string,
    decision: 'grant' | 'deny',
    fromWebContentsId: number,
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) throw new ScopeRequestTimeoutError('unknown requestId', requestId);
    if (entry.resolved) {
      throw new ScopeRequestTimeoutError('already resolved', requestId);
    }
    if (entry.webContentsId !== fromWebContentsId) {
      throw new ScopeRequestTimeoutError('wrong webContents', requestId);
    }
    if (Date.now() >= entry.expiresAt) {
      entry.resolved = true;
      entry.reject(new ScopeRequestTimeoutError('request expired', requestId));
      this.pending.delete(requestId);
      throw new ScopeRequestTimeoutError('request expired', requestId);
    }
    entry.resolved = true;
    entry.resolve(decision);
    this.pending.delete(requestId);
  }

  /**
   * Reject + drop every pending request originated by a given webContents.
   * Call when the owning window is closed/crashed: the awaiting renderer died
   * with it, so the host-side `await promise` would otherwise hang in the
   * `pending` Map until the 5min TTL sweep. Mirrors `cancelAgentAuthByWindow`
   * (agent-auth) / `broker.cancelByWindow` (hook-bridge) — the parallel
   * "window closed but waiter still pending" cleanup channels. Returns count.
   */
  cancelBySender(webContentsId: number): number {
    let n = 0;
    for (const [requestId, entry] of this.pending) {
      if (entry.resolved) continue;
      if (entry.webContentsId !== webContentsId) continue;
      entry.resolved = true;
      entry.reject(new ScopeRequestTimeoutError('window closed', requestId));
      this.pending.delete(requestId);
      n++;
    }
    return n;
  }

  /** Renderer keepalive - prompt visible. Resets expiresAt to now + PING_REFRESH_MS. */
  ping(requestId: string, fromWebContentsId: number): void {
    const entry = this.pending.get(requestId);
    if (!entry || entry.resolved) return;
    if (entry.webContentsId !== fromWebContentsId) return;
    entry.expiresAt = Date.now() + PING_REFRESH_MS;
  }

  /** Test-only: synchronous GC sweep skipping setInterval. */
  _sweep(): void {
    const now = Date.now();
    for (const [requestId, entry] of this.pending) {
      if (entry.resolved) continue;
      if (now >= entry.expiresAt) {
        entry.resolved = true;
        entry.reject(new ScopeRequestTimeoutError('request expired', requestId));
        this.pending.delete(requestId);
      }
    }
  }

  /** Stops GC interval. Call on host shutdown. Used in tests for cleanup. */
  dispose(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  /** Test-only inspect. */
  _peek(requestId: string): PendingEntry | undefined {
    return this.pending.get(requestId);
  }
}

export const DEFAULT_TTL_MS_FOR_TEST = DEFAULT_TTL_MS;
export const GC_INTERVAL_MS_FOR_TEST = GC_INTERVAL_MS;
export const PING_REFRESH_MS_FOR_TEST = PING_REFRESH_MS;
