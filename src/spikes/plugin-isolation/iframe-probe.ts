import type { IframeVerdict } from './types';

const MAIN_TIMEOUT_MS = 1500;
const INLINE_TIMEOUT_MS = 500;
const PING_COUNT = 5;

export type IframeProbeResult = {
  main: IframeVerdict;
  inline?: IframeVerdict;
};

export async function runIframeProbe(): Promise<IframeProbeResult> {
  const main = await runBlobIframeProbe();
  const inline = await runInlineIframeProbe();
  return { main, inline };
}

export function isStrictSandbox(sandbox: DOMTokenList): boolean {
  return (
    sandbox.length === 1 &&
    sandbox.contains('allow-scripts') &&
    !sandbox.contains('allow-same-origin')
  );
}

async function runBlobIframeProbe(): Promise<IframeVerdict> {
  let iframe: HTMLIFrameElement | null = null;
  let objectUrl: string | null = null;

  try {
    iframe = document.createElement('iframe');
    iframe.sandbox.add('allow-scripts');
    if (!isStrictSandbox(iframe.sandbox)) {
      throw new Error('sandbox-strict-check-failed');
    }

    const html = `
      <!doctype html>
      <script>
        window.addEventListener('message', (ev) => {
          parent.postMessage({ type: 'iframe-pong', received: ev.data }, '*');
        });
      </script>
    `;

    objectUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    iframe.src = objectUrl;
    document.body.append(iframe);

    await waitForLoad(iframe, MAIN_TIMEOUT_MS);

    let totalMs = 0;
    for (let i = 0; i < PING_COUNT; i += 1) {
      totalMs += await pingIframe(iframe, MAIN_TIMEOUT_MS);
    }

    return {
      state: 'blob-loaded-ok',
      ms: totalMs / PING_COUNT,
    };
  } catch (error) {
    if (isFrameBlobBlocked(error)) {
      return { state: 'frame-blob-blocked', cspContent: readCspMeta() };
    }
    return { state: 'iframe-throw', error: String(error) };
  } finally {
    iframe?.remove();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

async function runInlineIframeProbe(): Promise<IframeVerdict> {
  let iframe: HTMLIFrameElement | null = null;

  try {
    iframe = document.createElement('iframe');
    iframe.sandbox.add('allow-scripts');
    if (!isStrictSandbox(iframe.sandbox)) {
      throw new Error('sandbox-strict-check-failed');
    }

    const startedAt = performance.now();
    iframe.srcdoc = '<script>parent.postMessage("inline-pong","*")</script>';
    document.body.append(iframe);

    await waitForInlinePong(INLINE_TIMEOUT_MS);
    return { state: 'blob-loaded-ok', ms: performance.now() - startedAt };
  } catch {
    return { state: 'csp-blocks-inline', cspContent: readCspMeta() };
  } finally {
    iframe?.remove();
  }
}

function waitForLoad(iframe: HTMLIFrameElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('frame-blob-blocked'));
    }, timeoutMs);

    const onLoad = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error('frame-blob-blocked'));
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      iframe.removeEventListener('load', onLoad);
      iframe.removeEventListener('error', onError);
    };

    iframe.addEventListener('load', onLoad);
    iframe.addEventListener('error', onError);
  });
}

function pingIframe(iframe: HTMLIFrameElement, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('frame-blob-blocked'));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      if (!event.data || event.data.type !== 'iframe-pong') return;
      cleanup();
      resolve(performance.now() - startedAt);
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };

    window.addEventListener('message', onMessage);
    iframe.contentWindow?.postMessage({ type: 'ping' }, '*');
  });
}

function waitForInlinePong(timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('csp-blocks-inline'));
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      if (event.data !== 'inline-pong') return;
      cleanup();
      resolve();
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };

    window.addEventListener('message', onMessage);
  });
}

function readCspMeta(): string | null {
  return (
    document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content') ?? null
  );
}

function isFrameBlobBlocked(error: unknown): boolean {
  const text = String(error);
  return text.includes('frame-blob-blocked') || text.includes('CSP') || text.includes('Refused');
}
