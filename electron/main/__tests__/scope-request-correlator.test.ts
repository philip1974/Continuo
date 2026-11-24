import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_QUEUE_MAX_MS_FOR_TEST,
  DEFAULT_TTL_MS_FOR_TEST,
  ScopeRequestCorrelator,
} from '../services/scope-request-correlator';
import { ScopeRequestTimeoutError } from '../../shared/plugin-fs-contract';

let correlator: ScopeRequestCorrelator | null = null;

function makeCorrelator(): ScopeRequestCorrelator {
  correlator = new ScopeRequestCorrelator();
  return correlator;
}

describe('ScopeRequestCorrelator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    correlator?.dispose();
    correlator = null;
    vi.useRealTimers();
  });

  it('T21.a createRequest returns requestId + pending promise', async () => {
    const local = makeCorrelator();
    const { requestId, promise } = local.createRequest('token-a', 10);
    let settled = false;

    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();

    expect(requestId).toHaveLength(36);
    expect(requestId.split('-')).toHaveLength(5);
    expect(settled).toBe(false);
  });

  it('T21.b resolve correct requestId settles promise with decision', async () => {
    const local = makeCorrelator();
    const { requestId, promise } = local.createRequest('token-b', 10);

    local.resolve(requestId, 'grant', 10);

    await expect(promise).resolves.toBe('grant');
  });

  it('T21.c resolve unknown requestId throws ScopeRequestTimeoutError', () => {
    const local = makeCorrelator();

    expect(() => local.resolve('nonexistent', 'grant', 0)).toThrow(
      ScopeRequestTimeoutError,
    );
    expect(() => local.resolve('nonexistent', 'grant', 0)).toThrow(
      'unknown requestId',
    );
  });

  it('T21.d resolve wrong webContents throws', () => {
    const local = makeCorrelator();
    const { requestId } = local.createRequest('token-d', 10);

    expect(() => local.resolve(requestId, 'deny', 11)).toThrow(
      ScopeRequestTimeoutError,
    );
    expect(() => local.resolve(requestId, 'deny', 11)).toThrow(
      'wrong webContents',
    );
  });

  it('T21.e one-shot consume rejects second resolve', async () => {
    const local = makeCorrelator();
    const { requestId, promise } = local.createRequest('token-e', 10);

    local.resolve(requestId, 'grant', 10);
    await expect(promise).resolves.toBe('grant');

    expect(() => local.resolve(requestId, 'deny', 10)).toThrow(
      ScopeRequestTimeoutError,
    );
    expect(() => local.resolve(requestId, 'deny', 10)).toThrow(/unknown|already/);
  });

  it('T21.f 显示后无应答满 TTL → reject 并清掉条目', async () => {
    const local = makeCorrelator();
    const { requestId, promise } = local.createRequest('token-f', 10);
    const rejected = expect(promise).rejects.toThrow('request expired');

    expect(local.markShown(requestId, 10)).toBe(true);
    vi.advanceTimersByTime(DEFAULT_TTL_MS_FOR_TEST - 1);
    expect(local._peek(requestId)).toBeDefined();
    vi.advanceTimersByTime(1);

    await rejected;
    expect(local._peek(requestId)).toBeUndefined();
  });

  it('T21.g 排队中(未显示)不按 TTL 过期;排队兜底上限到点 → reject', async () => {
    const local = makeCorrelator();
    const { requestId, promise } = local.createRequest('token-g', 10);
    const rejected = expect(promise).rejects.toThrow('request expired');

    vi.advanceTimersByTime(DEFAULT_TTL_MS_FOR_TEST + 60_000);
    expect(local._peek(requestId)).toBeDefined();
    vi.advanceTimersByTime(DEFAULT_QUEUE_MAX_MS_FOR_TEST - DEFAULT_TTL_MS_FOR_TEST - 60_000);

    await rejected;
    expect(local._peek(requestId)).toBeUndefined();
  });

  it('T21.h 显示计时从标记时起算:排队 4 分 50 秒后才显示,仍有完整 TTL', async () => {
    const local = makeCorrelator();
    const { requestId, promise } = local.createRequest('token-h', 10);
    vi.advanceTimersByTime(290_000);
    local.markShown(requestId, 10);
    vi.advanceTimersByTime(DEFAULT_TTL_MS_FOR_TEST - 1);

    local.resolve(requestId, 'grant', 10);
    await expect(promise).resolves.toBe('grant');
  });

  it('T21.i markShown 只认本 webContents、只生效一次(重复标记不续期)', async () => {
    const local = makeCorrelator();
    const { requestId, promise } = local.createRequest('token-i', 10);
    const rejected = expect(promise).rejects.toThrow('request expired');

    expect(local.markShown(requestId, 11)).toBe(false);
    expect(local.markShown('nonexistent', 10)).toBe(false);
    expect(local.markShown(requestId, 10)).toBe(true);
    vi.advanceTimersByTime(DEFAULT_TTL_MS_FOR_TEST - 1_000);
    expect(local.markShown(requestId, 10)).toBe(false);
    vi.advanceTimersByTime(1_000);

    await rejected;
  });

  it('T21.j 已应答 / 已撤销的请求不再被计时器 reject', async () => {
    const local = makeCorrelator();
    const a = local.createRequest('token-j', 10);
    local.markShown(a.requestId, 10);
    local.resolve(a.requestId, 'deny', 10);
    vi.advanceTimersByTime(DEFAULT_QUEUE_MAX_MS_FOR_TEST * 2);
    await expect(a.promise).resolves.toBe('deny');
    expect(vi.getTimerCount()).toBe(0);
  });
});
