import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TTL_MS_FOR_TEST,
  GC_INTERVAL_MS_FOR_TEST,
  PING_REFRESH_MS_FOR_TEST,
  ScopeRequestCorrelator,
} from '../services/scope-request-correlator';
import { ScopeRequestTimeoutError, type PathScope } from '../../../src/plugins/types';

const SCOPES: readonly PathScope[] = [{ path: '/tmp', mode: 'rw' }];
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
    const { requestId, promise } = local.createRequest('token-a', SCOPES, 10);
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
    const { requestId, promise } = local.createRequest('token-b', SCOPES, 10);

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
    const { requestId } = local.createRequest('token-d', SCOPES, 10);

    expect(() => local.resolve(requestId, 'deny', 11)).toThrow(
      ScopeRequestTimeoutError,
    );
    expect(() => local.resolve(requestId, 'deny', 11)).toThrow(
      'wrong webContents',
    );
  });

  it('T21.e one-shot consume rejects second resolve', async () => {
    const local = makeCorrelator();
    const { requestId, promise } = local.createRequest('token-e', SCOPES, 10);

    local.resolve(requestId, 'grant', 10);
    await expect(promise).resolves.toBe('grant');

    expect(() => local.resolve(requestId, 'deny', 10)).toThrow(
      ScopeRequestTimeoutError,
    );
    expect(() => local.resolve(requestId, 'deny', 10)).toThrow(/unknown|already/);
  });

  it('T21.f TTL automatically rejects promise and clears entry', async () => {
    const local = makeCorrelator();
    const { requestId, promise } = local.createRequest('token-f', SCOPES, 10);
    const rejected = expect(promise).rejects.toBeInstanceOf(
      ScopeRequestTimeoutError,
    );

    vi.advanceTimersByTime(
      DEFAULT_TTL_MS_FOR_TEST + GC_INTERVAL_MS_FOR_TEST + 1_000,
    );

    await rejected;
    expect(local._peek(requestId)).toBeUndefined();
  });

  it('T21.g ping resets expiresAt and allows later resolve', async () => {
    const local = makeCorrelator();
    const { requestId, promise } = local.createRequest('token-g', SCOPES, 10);

    vi.advanceTimersByTime(200_000);
    local.ping(requestId, 10);
    expect(local._peek(requestId)?.expiresAt).toBe(
      Date.now() + PING_REFRESH_MS_FOR_TEST,
    );

    vi.advanceTimersByTime(200_000);
    local.resolve(requestId, 'grant', 10);

    await expect(promise).resolves.toBe('grant');
  });

  it('T21.h ping from wrong sender is ignored', () => {
    const local = makeCorrelator();
    const { requestId } = local.createRequest('token-h', SCOPES, 10);
    const initialExpiresAt = local._peek(requestId)?.expiresAt;

    vi.advanceTimersByTime(1_000);
    local.ping(requestId, 11);

    expect(local._peek(requestId)?.expiresAt).toBe(initialExpiresAt);
  });
});
