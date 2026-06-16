import type { SabVerdict } from './types';

const TIMEOUT_MS = 1500;

export async function runSabProbe(): Promise<SabVerdict> {
  const crossOriginIsolated = readCrossOriginIsolated();
  let worker: Worker | null = null;
  let objectUrl: string | null = null;

  try {
    const workerCode = `
      self.addEventListener('message', (ev) => {
        try {
          const view = new Int32Array(ev.data);
          const startedAt = performance.now();
          Atomics.wait(view, 0, 0, 50);
          self.postMessage({ type: 'sab-ok', ms: performance.now() - startedAt });
        } catch (error) {
          self.postMessage({ type: 'sab-error', error: String(error) });
        }
      });
    `;

    objectUrl = URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' }));
    worker = new Worker(objectUrl, { type: 'module' });
  } catch {
    return { state: 'worker-create-fail', blockedBy: 'worker', crossOriginIsolated };
  }

  let sab: SharedArrayBuffer;
  try {
    sab = new SharedArrayBuffer(8);
  } catch (error) {
    worker.terminate();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return { state: 'sab-construct-fail', error: String(error), crossOriginIsolated };
  }

  try {
    const result = waitForSabWorker(worker);
    worker.postMessage(sab);
    const workerResult = await result;
    return { state: 'ok', ms: workerResult.ms, crossOriginIsolated };
  } catch (error) {
    const errorText = String(error);
    if (errorText.includes('postMessage')) {
      return { state: 'sab-postmessage-fail', error: errorText, crossOriginIsolated };
    }
    return { state: 'atomics-wait-fail', error: errorText, crossOriginIsolated };
  } finally {
    worker.terminate();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export function assertWorkerThreadForAtomicsWait(scope: {
  WorkerGlobalScope?: unknown;
  document?: unknown;
}): void {
  if (scope.document) {
    throw new Error('Atomics.wait must run in a worker');
  }
}

function waitForSabWorker(worker: Worker): Promise<{ ms: number }> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('atomics-wait-timeout'));
    }, TIMEOUT_MS);

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'sab-ok') {
        cleanup();
        resolve({ ms: Number(event.data.ms) });
        return;
      }
      if (event.data?.type === 'sab-error') {
        cleanup();
        reject(new Error(String(event.data.error)));
      }
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
  });
}

function readCrossOriginIsolated(): boolean {
  return Boolean(globalThis.crossOriginIsolated);
}

