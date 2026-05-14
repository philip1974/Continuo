// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureLmApi, _resetLmApiForTest } from '../../lib/co-api';
import {
  createSpawnQueue,
  _resetModuleSpawnStateForTest,
} from '../../panels/Terminal/spawnLeaf';

describe('terminal pane internal split - leaf level cancellation token', () => {
  beforeEach(() => {
    _resetLmApiForTest();
    _resetModuleSpawnStateForTest();
  });

  it('cancels only the requested leaf spawn and removes the late PTY once', async () => {
    let resolveA!: (value: unknown) => void;
    let resolveB!: (value: unknown) => void;
    const remove = vi.fn().mockResolvedValue({ ok: true });
    const create = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveB = resolve;
          }),
      );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { terminal: { create, remove } },
    });
    captureLmApi();
    const removed = new Set<string>();
    const dispatch = vi.fn();
    const queue = createSpawnQueue(dispatch, removed, 'panel-test');

    queue.enqueue({
      tabId: 'tab-1',
      leafId: 'leaf-a',
      reason: 'hydrate',
      scoped: true,
      cancelled: { current: false },
    });
    queue.enqueue({
      tabId: 'tab-1',
      leafId: 'leaf-b',
      reason: 'hydrate',
      scoped: true,
      cancelled: { current: false },
    });
    queue.cancelLeaf('tab-1', 'leaf-a');

    resolveA({ ok: true, data: { id: 'pty-a' } });
    resolveB({ ok: true, data: { id: 'pty-b' } });
    await Promise.resolve();
    await Promise.resolve();

    expect(remove).toHaveBeenCalledWith('pty-a');
    expect(removed.has('pty-a')).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'PANE_ACTION',
      tabId: 'tab-1',
      action: { type: 'SET_PTY_ID', leafId: 'leaf-b', ptyId: 'pty-b', cwd: undefined },
    });
  });

  it('logs ok=false when cancelled cleanup removal fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        terminal: {
          create: vi.fn().mockResolvedValue({ ok: true, data: { id: 'pty-a' } }),
          remove: vi.fn().mockResolvedValue({ ok: false, code: 'ENOENT' }),
        },
      },
    });
    captureLmApi();
    const queue = createSpawnQueue(vi.fn(), new Set(), 'panel-test');
    queue.enqueue({
      tabId: 'tab-1',
      leafId: 'leaf-a',
      reason: 'split',
      scoped: true,
      cancelled: { current: true },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith(
      '[pane-split] cancelled-spawn remove ok=false',
      'pty-a',
      expect.objectContaining({ ok: false }),
    );
  });
});
