// @vitest-environment jsdom
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type WorkerProbeResult =
  | { ok: true; ms: number; cspContent: string | null }
  | { ok: false; error: 'CSP-block' | 'timeout' | string; cspContent: string | null };

type WorkerProbeModule = {
  runWorkerProbe(options?: { timeoutMs?: number }): Promise<WorkerProbeResult>;
};

const implementationPath = resolve(process.cwd(), 'src/spikes/plugin-isolation/worker-probe.ts');
const modulePath = '@/spikes/plugin-isolation/worker-probe';
const describeIfImplemented = existsSync(implementationPath) ? describe : describe.skip;

async function loadWorkerProbe(): Promise<WorkerProbeModule> {
  return import(modulePath) as Promise<WorkerProbeModule>;
}

function setCsp(content: string): void {
  document.head.innerHTML = '';
  const meta = document.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = content;
  document.head.append(meta);
}

describeIfImplemented('topic 45 worker probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.head.innerHTML = '';
  });

  it('returns ok with ms and cspContent when blob Worker answers ping/pong', async () => {
    setCsp("default-src 'self'; worker-src blob:");
    const postMessage = vi.fn();
    const terminate = vi.fn();
    stubObjectUrl();

    vi.stubGlobal(
      'Worker',
      class MockWorker extends EventTarget {
        terminate = terminate;
        postMessage = postMessage.mockImplementation((data: unknown) => {
          queueMicrotask(() => {
            this.dispatchEvent(new MessageEvent('message', { data: { type: 'pong', received: data } }));
          });
        });
      },
    );

    const result = await (await loadWorkerProbe()).runWorkerProbe({ timeoutMs: 1000 });

    expect(result.ok).toBe(true);
    if (result.ok === false) throw new Error(`expected worker probe ok, got ${result.error}`);
    expect(result.ms).toBeLessThan(1000);
    expect(result.cspContent).toBe("default-src 'self'; worker-src blob:");
    expect(postMessage).toHaveBeenCalledWith({ type: 'ping' });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('maps Worker SecurityError construction failure to CSP-block and includes cspContent', async () => {
    setCsp("default-src 'self'; worker-src 'none'");
    vi.stubGlobal(
      'Worker',
      vi.fn(() => {
        throw new DOMException('blocked', 'SecurityError');
      }),
    );

    stubObjectUrl();

    await expect((await loadWorkerProbe()).runWorkerProbe()).resolves.toMatchObject({
      ok: false,
      error: 'CSP-block',
      cspContent: "default-src 'self'; worker-src 'none'",
    });
  });

  it('returns timeout when ping receives no pong before 1s', async () => {
    setCsp("default-src 'self'; worker-src blob:");
    vi.useFakeTimers();
    stubObjectUrl();
    vi.stubGlobal(
      'Worker',
      class MockWorker extends EventTarget {
        terminate = vi.fn();
        postMessage = vi.fn();
      },
    );

    const pending = (await loadWorkerProbe()).runWorkerProbe({ timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toMatchObject({ ok: false, error: 'timeout' });
    vi.useRealTimers();
  });

  it('reads cspContent from meta[http-equiv="Content-Security-Policy"]', async () => {
    setCsp("script-src 'self' blob:");
    stubObjectUrl();
    vi.stubGlobal(
      'Worker',
      vi.fn(() => {
        throw new DOMException('blocked', 'SecurityError');
      }),
    );

    const result = await (await loadWorkerProbe()).runWorkerProbe();

    expect(result.cspContent).toBe("script-src 'self' blob:");
  });

  it('returns empty cspContent when no CSP meta tag is present', async () => {
    document.head.innerHTML = '';
    stubObjectUrl();
    vi.stubGlobal(
      'Worker',
      vi.fn(() => {
        throw new DOMException('blocked', 'SecurityError');
      }),
    );

    const result = await (await loadWorkerProbe()).runWorkerProbe();

    expect(result.cspContent).toBeNull();
  });
});

function stubObjectUrl(): void {
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:continuo-worker-probe'),
    revokeObjectURL: vi.fn(),
  });
}
