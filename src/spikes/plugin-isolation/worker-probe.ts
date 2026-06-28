import type { WorkerVerdict } from './types';

const PING_COUNT = 5;
const TIMEOUT_MS = 1000;

export async function runWorkerProbe(): Promise<WorkerVerdict> {
  const cspContent = readCspMeta();
  let worker: Worker | null = null;
  let objectUrl: string | null = null;

  try {
    const workerCode = `
      self.addEventListener('message', (ev) => {
        self.postMessage({ type: 'pong', received: ev.data });
      });
    `;

    objectUrl = URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' }));
    worker = new Worker(objectUrl, { type: 'module' });

    let totalMs = 0;
    for (let i = 0; i < PING_COUNT; i += 1) {
      totalMs += await ping(worker);
    }

    return {
      ok: true,
      ms: totalMs / PING_COUNT,
      cspContent,
    };
  } catch (error) {
    if (isCspCreateError(error)) {
      return { ok: false, error: 'CSP-block', cspContent, ms: 0 };
    }
    if (isTimeoutError(error)) {
      return { ok: false, error: 'timeout', cspContent };
    }
    return { ok: false, error: String(error), cspContent };
  } finally {
    worker?.terminate();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function ping(worker: Worker): Promise<number> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('timeout'));
    }, TIMEOUT_MS);

    const onMessage = (event: MessageEvent) => {
      if (!event.data || event.data.type !== 'pong') return;
      cleanup();
      resolve(performance.now() - startedAt);
    };

    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(event.error ?? new Error(event.message));
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ type: 'ping' });
  });
}

function readCspMeta(): string | null {
  return (
    document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content') ?? null
  );
}

function isCspCreateError(error: unknown): boolean {
  const text = String(error);
  return text.includes('CSP') || text.includes('Refused') || text.includes('SecurityError');
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === 'timeout';
}
