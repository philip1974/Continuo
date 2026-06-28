// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IframeProbeResult = { main: IframeVerdict; inline?: IframeVerdict };

type IframeVerdict =
  | { state: 'blob-loaded-ok'; ms: number }
  | { state: 'frame-blob-blocked'; cspContent: string | null }
  | { state: 'iframe-throw'; error: string }
  | { state: 'csp-blocks-inline'; cspContent: string | null };

type IframeProbeModule = {
  runIframeProbe(options?: { timeoutMs?: number }): Promise<IframeProbeResult>;
  isStrictSandbox(sandbox: DOMTokenList): boolean;
};

const implementationPath = resolve(process.cwd(), 'src/spikes/plugin-isolation/iframe-probe.ts');
const modulePath = '@/spikes/plugin-isolation/iframe-probe';
const describeIfImplemented = existsSync(implementationPath) ? describe : describe.skip;

async function loadIframeProbe(): Promise<IframeProbeModule> {
  return import(modulePath) as Promise<IframeProbeModule>;
}

function createSandbox(tokens: string[]): DOMTokenList {
  const iframe = document.createElement('iframe');
  for (const token of tokens) iframe.sandbox.add(token);
  return iframe.sandbox;
}

describeIfImplemented('topic 45 iframe probe', () => {
  beforeEach(() => {
    installSandboxPolyfill();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('reports blob-loaded-ok when a sandboxed blob iframe posts ready', async () => {
    stubObjectUrl();
    stubIframePostMessage();
    stubAppendForBlobAndInlineSuccess();

    const result = await (await loadIframeProbe()).runIframeProbe();

    expect(result.main.state).toBe('blob-loaded-ok');
    expect(result.inline?.state).toBe('blob-loaded-ok');
  });

  it('reports frame-blob-blocked when CSP prevents blob iframe navigation', async () => {
    stubObjectUrl();
    vi.spyOn(document.body, 'append').mockImplementation(() => {
      throw new DOMException('Refused to frame blob', 'SecurityError');
    });

    await expect((await loadIframeProbe()).runIframeProbe()).resolves.toMatchObject({
      main: { state: 'frame-blob-blocked' },
    });
  });

  it('reports iframe-throw when iframe creation or wiring throws non-CSP errors', async () => {
    vi.spyOn(document, 'createElement').mockImplementation(() => {
      throw new Error('iframe unavailable');
    });

    await expect((await loadIframeProbe()).runIframeProbe()).resolves.toMatchObject({
      main: { state: 'iframe-throw' },
    });
  });

  it('reports csp-blocks-inline as an evidence state', async () => {
    stubObjectUrl();
    stubIframePostMessage();
    stubAppendForBlobOnly();

    const result = await (await loadIframeProbe()).runIframeProbe();

    expect(result.main.state).toBe('blob-loaded-ok');
    expect(result.inline).toMatchObject({ state: 'csp-blocks-inline' });
  });

  it('accepts exactly sandbox="allow-scripts"', async () => {
    expect((await loadIframeProbe()).isStrictSandbox(createSandbox(['allow-scripts']))).toBe(true);
  });

  it('rejects sandbox when allow-same-origin is present', async () => {
    expect(
      (await loadIframeProbe()).isStrictSandbox(
        createSandbox(['allow-scripts', 'allow-same-origin']),
      ),
    ).toBe(false);
  });

  it('rejects sandbox when more than one token is present', async () => {
    expect((await loadIframeProbe()).isStrictSandbox(createSandbox(['allow-scripts', 'allow-popups']))).toBe(
      false,
    );
  });

  it('keeps csp_blocks_inline independent from the main verdict field', async () => {
    stubObjectUrl();
    stubIframePostMessage();
    stubAppendForBlobOnly();

    const result = await (await loadIframeProbe()).runIframeProbe();

    expect(result.main.state).not.toBe('csp-blocks-inline');
    expect(result.inline?.state).toBe('csp-blocks-inline');
  });

  it('computes ping average without Array.reduce callback', () => {
    const src = readFileSync(implementationPath, 'utf8');
    expect(src).not.toContain('samples.reduce(');
  });
});

function installSandboxPolyfill(): void {
  const store = new WeakMap<HTMLIFrameElement, Set<string>>();

  Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', {
    configurable: true,
    get() {
      const iframe = this as HTMLIFrameElement;
      let tokens = store.get(iframe);
      if (!tokens) {
        tokens = new Set<string>();
        store.set(iframe, tokens);
      }

      return {
        get length() {
          return tokens.size;
        },
        add(token: string) {
          tokens.add(token);
        },
        contains(token: string) {
          return tokens.has(token);
        },
      } as DOMTokenList;
    },
  });
}

function stubObjectUrl(): void {
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:continuo-iframe-probe'),
    revokeObjectURL: vi.fn(),
  });
}

function stubIframePostMessage(): void {
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get() {
      return {
        postMessage(data: unknown) {
          queueMicrotask(() => {
            window.dispatchEvent(
              new MessageEvent('message', { data: { type: 'iframe-pong', received: data } }),
            );
          });
        },
      };
    },
  });
}

function stubAppendForBlobAndInlineSuccess(): void {
  vi.spyOn(document.body, 'append').mockImplementation((...nodes: (string | Node)[]) => {
    const node = nodes[0] as Node;
    const iframe = node as HTMLIFrameElement;
    queueMicrotask(() => {
      if (iframe.srcdoc) {
        window.dispatchEvent(new MessageEvent('message', { data: 'inline-pong' }));
      } else {
        iframe.dispatchEvent(new Event('load'));
      }
    });
  });
}

function stubAppendForBlobOnly(): void {
  vi.spyOn(document.body, 'append').mockImplementation((...nodes: (string | Node)[]) => {
    const node = nodes[0] as Node;
    const iframe = node as HTMLIFrameElement;
    if (!iframe.srcdoc) {
      queueMicrotask(() => iframe.dispatchEvent(new Event('load')));
    }
  });
}
