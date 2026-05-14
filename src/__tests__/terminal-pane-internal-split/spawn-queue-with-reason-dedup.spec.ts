// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLmApi, _resetLmApiForTest } from '../../lib/co-api';
import {
  createSpawnQueue,
  type SpawnRequest,
} from '../../panels/Terminal/spawnLeaf';

function request(over: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    tabId: 'tab-1',
    leafId: 'leaf-1',
    scoped: true,
    reason: 'split',
    cancelled: { current: false },
    ...over,
  };
}

describe('terminal pane internal split - spawn queue with reason and dedup', () => {
  beforeEach(() => {
    _resetLmApiForTest();
  });

  it('deduplicates pending requests by tabId and leafId', async () => {
    let resolveCreate!: (value: unknown) => void;
    const create = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { terminal: { create, remove: vi.fn() } },
    });
    captureLmApi();
    const dispatch = vi.fn();
    const queue = createSpawnQueue(dispatch, new Set());

    queue.enqueue(request({ reason: 'hydrate' }));
    queue.enqueue(request({ reason: 'split' }));

    expect(create).toHaveBeenCalledTimes(1);
    resolveCreate({ ok: true, data: { id: 'term-1', cwd: '/repo' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith({
      type: 'PANE_ACTION',
      tabId: 'tab-1',
      action: { type: 'SET_PTY_ID', leafId: 'leaf-1', ptyId: 'term-1', cwd: '/repo' },
    });
  });

  it('keeps independent leaf requests in flight', () => {
    const create = vi.fn(() => new Promise(() => {}));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { terminal: { create, remove: vi.fn() } },
    });
    captureLmApi();

    const queue = createSpawnQueue(vi.fn(), new Set());
    queue.enqueue(request({ leafId: 'leaf-1', reason: 'hydrate' }));
    queue.enqueue(request({ leafId: 'leaf-2', reason: 'split' }));

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ scoped: true }),
    );
  });

  it('dispatches SET_PTY_FAIL with reason visible in warning when create fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        terminal: {
          create: vi.fn().mockResolvedValue({ ok: false, code: 'EPTY', message: 'bad pty' }),
          remove: vi.fn(),
        },
      },
    });
    captureLmApi();
    const dispatch = vi.fn();
    createSpawnQueue(dispatch, new Set()).enqueue(request({ reason: 'retry' }));

    await Promise.resolve();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledWith({
      type: 'PANE_ACTION',
      tabId: 'tab-1',
      action: { type: 'SET_PTY_FAIL', leafId: 'leaf-1' },
    });
    expect(warn).toHaveBeenCalledWith('[pane-split] spawn-failed', 'retry', 'EPTY', 'bad pty');
  });
});
