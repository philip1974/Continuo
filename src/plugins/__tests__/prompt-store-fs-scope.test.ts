// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetLmApiForTest } from '@/lib/co-api';
import {
  usePermissionPromptStore,
  type FsScopePrompt,
} from '../permissions/promptStore';
import {
  expandScopePathForDisplay,
  startPluginFsScopeRequestBridge,
} from '../permissions/usePluginFsScopeRequests';

beforeEach(() => {
  _resetLmApiForTest();
  usePermissionPromptStore.setState({
    pending: null,
    resolve: null,
    fsScopePending: {},
    fsScopeQueue: [],
    currentFsScope: null,
  });
  vi.restoreAllMocks();
});

afterEach(() => {
  _resetLmApiForTest();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function prompt(requestId: string): FsScopePrompt {
  return {
    requestId,
    pluginId: 'com.test',
    scopes: [{ path: '/tmp/x', displayPath: '/tmp/x', mode: 'rw' }],
  };
}

describe('permission prompt store fs-scope flow', () => {
  it('adds fs-scope request keyed by requestId', () => {
    void usePermissionPromptStore.getState().requestFsScope(prompt('r1'));

    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe(
      'r1',
    );
    expect(Object.keys(usePermissionPromptStore.getState().fsScopePending)).toEqual([
      'r1',
    ]);
  });

  it('resolves grant for the matching request only', async () => {
    const p1 = usePermissionPromptStore.getState().requestFsScope(prompt('r1'));
    const p2 = usePermissionPromptStore.getState().requestFsScope(prompt('r2'));

    usePermissionPromptStore.getState().grantFsScope('r2');

    await expect(p2).resolves.toBe('grant');
    expect(usePermissionPromptStore.getState().fsScopePending['r1']).toBeDefined();
    usePermissionPromptStore.getState().denyFsScope('r1');
    await expect(p1).resolves.toBe('deny');
  });

  it('keeps FIFO currentFsScope while resolving concurrent requests', async () => {
    const p1 = usePermissionPromptStore.getState().requestFsScope(prompt('r1'));
    const p2 = usePermissionPromptStore.getState().requestFsScope(prompt('r2'));

    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe(
      'r1',
    );
    usePermissionPromptStore.getState().grantFsScope('r1');
    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe(
      'r2',
    );
    usePermissionPromptStore.getState().grantFsScope('r2');

    await expect(p1).resolves.toBe('grant');
    await expect(p2).resolves.toBe('grant');
    expect(usePermissionPromptStore.getState().currentFsScope).toBeNull();
  });

  it('expands tilde for display when HOME is available', () => {
    vi.stubEnv('HOME', '/Users/tester');

    expect(expandScopePathForDisplay('~/skills')).toBe('/Users/tester/skills');
  });

  it('bridge sends scopeDecision without mixing concurrent requests', async () => {
    let handler:
      | ((payload: {
          requestId: string;
          pluginId: string;
          scopes: readonly { path: string; mode: 'r' | 'rw' }[];
        }) => void)
      | null = null;
    const decisions: { requestId: string; decision: 'grant' | 'deny' }[] = [];
    Object.defineProperty(window, '__lmApi', {
      configurable: true,
      value: {
        pluginFsRaw: {
          onScopeRequest: vi.fn((cb: NonNullable<typeof handler>) => {
            handler = cb;
            return () => {
              handler = null;
            };
          }),
          _scopeDecision: vi.fn(
            (requestId: string, decision: 'grant' | 'deny') => {
            decisions.push({ requestId, decision });
            return Promise.resolve();
            },
          ),
        },
      },
    });

    const unsubscribe = startPluginFsScopeRequestBridge();
    if (!handler) throw new Error('scope request handler was not registered');
    handler({
      requestId: 'r1',
      pluginId: 'com.test',
      scopes: [{ path: '/tmp/a', mode: 'r' }],
    });
    handler({
      requestId: 'r2',
      pluginId: 'com.test',
      scopes: [{ path: '/tmp/b', mode: 'rw' }],
    });

    usePermissionPromptStore.getState().denyFsScope('r2');
    usePermissionPromptStore.getState().grantFsScope('r1');
    await vi.waitFor(() => {
      expect(decisions).toEqual([
        { requestId: 'r2', decision: 'deny' },
        { requestId: 'r1', decision: 'grant' },
      ]);
    });
    unsubscribe();
  });
});
