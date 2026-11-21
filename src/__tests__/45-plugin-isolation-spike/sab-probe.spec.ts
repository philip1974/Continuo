// @vitest-environment jsdom
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type SabProbeState =
  | 'ok'
  | 'worker-create-fail'
  | 'sab-construct-fail'
  | 'sab-postmessage-fail'
  | 'atomics-wait-fail';

type SabProbeResult = {
  state: SabProbeState;
  crossOriginIsolated: boolean;
};

type SabProbeModule = {
  runSabProbe(options?: { timeoutMs?: number }): Promise<SabProbeResult>;
  assertWorkerThreadForAtomicsWait(scope: { WorkerGlobalScope?: unknown; document?: unknown }): void;
};

const implementationPath = resolve(process.cwd(), 'src/spikes/plugin-isolation/sab-probe.ts');
const modulePath = '@/spikes/plugin-isolation/sab-probe';
const describeIfImplemented = existsSync(implementationPath) ? describe : describe.skip;

async function loadSabProbe(): Promise<SabProbeModule> {
  return import(modulePath) as Promise<SabProbeModule>;
}

describeIfImplemented('topic 45 SharedArrayBuffer probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports worker-create-fail when the SAB worker cannot be created', async () => {
    stubObjectUrl();
    vi.stubGlobal(
      'Worker',
      vi.fn(() => {
        throw new DOMException('blocked', 'SecurityError');
      }),
    );

    await expect((await loadSabProbe()).runSabProbe()).resolves.toMatchObject({
      state: 'worker-create-fail',
    });
  });

  it('reports sab-construct-fail when SharedArrayBuffer construction fails inside worker', async () => {
    stubObjectUrl();
    vi.stubGlobal('Worker', successWorkerClass());
    vi.stubGlobal(
      'SharedArrayBuffer',
      vi.fn(() => {
        throw new Error('SAB unavailable');
      }),
    );

    await expect((await loadSabProbe()).runSabProbe()).resolves.toMatchObject({
      state: 'sab-construct-fail',
    });
  });

  it('reports sab-postmessage-fail when SAB cannot be posted back from worker', async () => {
    stubObjectUrl();
    vi.stubGlobal(
      'Worker',
      class MockWorker extends EventTarget {
        terminate = vi.fn();
        postMessage = vi.fn(() => {
          throw new Error('postMessage failed');
        });
      },
    );

    await expect((await loadSabProbe()).runSabProbe()).resolves.toMatchObject({
      state: 'sab-postmessage-fail',
    });
  });

  it('reports atomics-wait-fail when Atomics.wait fails in worker', async () => {
    stubObjectUrl();
    vi.stubGlobal(
      'Worker',
      class MockWorker extends EventTarget {
        terminate = vi.fn();
        postMessage = vi.fn(() => {
          queueMicrotask(() => {
            this.dispatchEvent(
              new MessageEvent('message', {
                data: { type: 'sab-error', error: 'Atomics.wait failed' },
              }),
            );
          });
        });
      },
    );

    await expect((await loadSabProbe()).runSabProbe()).resolves.toMatchObject({
      state: 'atomics-wait-fail',
    });
  });

  it('records self.crossOriginIsolated as a boolean evidence field', async () => {
    stubObjectUrl();
    vi.stubGlobal('Worker', successWorkerClass());
    Object.defineProperty(globalThis, 'crossOriginIsolated', {
      configurable: true,
      value: true,
    });

    const result = await (await loadSabProbe()).runSabProbe();

    expect(typeof result.crossOriginIsolated).toBe('boolean');
    expect(result).toMatchObject({ state: 'ok', crossOriginIsolated: true });
  });

  it('throws when Atomics.wait is attempted from the main thread contract path', async () => {
    const sabProbe = await loadSabProbe();

    expect(() => sabProbe.assertWorkerThreadForAtomicsWait({ document })).toThrow(/worker/i);
  });
});

function stubObjectUrl(): void {
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:continuo-sab-probe'),
    revokeObjectURL: vi.fn(),
  });
}

function successWorkerClass(): typeof Worker {
  return class MockWorker extends EventTarget {
    terminate = vi.fn();
    postMessage = vi.fn(() => {
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent('message', { data: { type: 'sab-ok', ms: 50 } }));
      });
    });
  } as unknown as typeof Worker;
}
