import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type SpikeAllowedReason = 'dev' | 'env-opt-in' | 'packaged-blocked' | 'env-missing';
type SpikeAllowedResult = { allowed: boolean; reason: SpikeAllowedReason };
type RendererQuery = Record<string, string>;
type NavigationEvent = { preventDefault: () => void };
type SpikeNavigationEvent = { preventDefault(): void; readonly url: string };
type WindowOpenDetails = { url: string };
type WindowOpenResult = { action: 'allow' | 'deny' };

type SpikeGateModule = {
  guardNav(event: NavigationEvent, url: string, packaged: boolean): SpikeAllowedResult;
  guardOpen(details: WindowOpenDetails, packaged: boolean): WindowOpenResult;
  stripSpikeQuery(query: RendererQuery, spikeAllowed: boolean): RendererQuery;
  buildRendererQuery(
    options: { workspace?: string; fresh?: boolean; windowSeq?: string; spike?: 'plugin-isolation' },
  ): RendererQuery;
  spikeAllowed(options: { url: string; argv: string[]; packaged: boolean }): SpikeAllowedResult;
  installSpikeGate(
    contents: {
      on(
        event: 'will-navigate' | 'will-frame-navigate',
        listener: (event: SpikeNavigationEvent) => void,
      ): void;
    },
    packaged: boolean,
  ): () => void;
};

const implementationPath = resolve(process.cwd(), 'electron/main/spike-gate.ts');
const modulePath = '../../../electron/main/spike-gate';
const describeIfImplemented = existsSync(implementationPath) ? describe : describe.skip;

async function loadSpikeGate(): Promise<SpikeGateModule> {
  return import(modulePath) as Promise<SpikeGateModule>;
}

describeIfImplemented('topic 45 packaged spike gate', () => {
  afterEach(() => {
    delete process.env.CONTINUO_SPIKE;
    vi.restoreAllMocks();
  });

  it('guardNav allows all spike navigations in dev', async () => {
    const preventDefault = vi.fn();

    (await loadSpikeGate()).guardNav(
      { preventDefault },
      'http://localhost:5173/?spike=plugin-isolation',
      false,
    );

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('guardNav blocks packaged spike navigation when env opt-in is absent', async () => {
    const preventDefault = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    (await loadSpikeGate()).guardNav(
      { preventDefault },
      'file:///app/index.html?spike=plugin-isolation',
      true,
    );

    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('guardNav allows packaged spike navigation when env opt-in is present', async () => {
    const preventDefault = vi.fn();
    process.env.CONTINUO_SPIKE = '1';

    (await loadSpikeGate()).guardNav(
      { preventDefault },
      'file:///app/index.html?spike=plugin-isolation',
      true,
    );

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('guardOpen allows dev spike windows through setWindowOpenHandler contract', async () => {
    expect(
      (await loadSpikeGate()).guardOpen(
        { url: 'http://localhost:5173/?spike=plugin-isolation' },
        false,
      ),
    ).toEqual({ action: 'allow' });
  });

  it('guardOpen denies packaged spike windows when env opt-in is absent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(
      (await loadSpikeGate()).guardOpen(
        { url: 'file:///app/index.html?spike=plugin-isolation' },
        true,
      ),
    ).toEqual({ action: 'deny' });
  });

  it('guardOpen allows packaged spike windows when env opt-in is present', async () => {
    process.env.CONTINUO_SPIKE = '1';

    expect(
      (await loadSpikeGate()).guardOpen(
        { url: 'file:///app/index.html?spike=plugin-isolation' },
        true,
      ),
    ).toEqual({ action: 'allow' });
  });

  it('stripSpikeQuery removes spike query when gate is closed', async () => {
    expect(
      (await loadSpikeGate()).stripSpikeQuery(
        { spike: 'plugin-isolation', spikeAck: '1', workspace: '/foo' },
        false,
      ),
    ).toEqual({ workspace: '/foo' });
  });

  it('stripSpikeQuery keeps spike query when gate is open', async () => {
    expect(
      (await loadSpikeGate()).stripSpikeQuery({ spike: 'plugin-isolation', workspace: '/foo' }, true),
    ).toEqual({ spike: 'plugin-isolation', workspace: '/foo' });
  });

  it('buildRendererQuery assembles renderer query fields before spike stripping', async () => {
    expect(
      (await loadSpikeGate()).buildRendererQuery({
        windowSeq: '2',
        workspace: '/foo',
        fresh: true,
        spike: 'plugin-isolation',
      }),
    ).toEqual({ windowSeq: '2', workspace: '/foo', fresh: '1', spike: 'plugin-isolation' });
  });

  it('spikeAllowed returns dev reason in development', async () => {
    expect(
      (await loadSpikeGate()).spikeAllowed({
        url: 'http://localhost:5173/?spike=plugin-isolation',
        argv: [],
        packaged: false,
      }),
    ).toEqual({ allowed: true, reason: 'dev' });
  });

  it('spikeAllowed returns env-opt-in reason for packaged opt-in', async () => {
    expect(
      (await loadSpikeGate()).spikeAllowed({
        url: 'file:///app/index.html?spike=plugin-isolation',
        argv: ['CONTINUO_SPIKE=1'],
        packaged: true,
      }),
    ).toEqual({ allowed: true, reason: 'env-opt-in' });
  });

  it('spikeAllowed returns packaged-blocked for packaged URL spike without opt-in', async () => {
    expect(
      (await loadSpikeGate()).spikeAllowed({
        url: 'file:///app/index.html?spike=plugin-isolation',
        argv: [],
        packaged: true,
      }),
    ).toEqual({ allowed: false, reason: 'packaged-blocked' });
  });

  it('spikeAllowed returns env-missing for packaged argv spike without opt-in', async () => {
    expect(
      (await loadSpikeGate()).spikeAllowed({
        url: 'file:///app/index.html',
        argv: [],
        packaged: true,
      }),
    ).toEqual({ allowed: false, reason: 'env-missing' });
  });

  it('spikeAllowed scans full argv for --spike opt-in in packaged mode', async () => {
    expect(
      (await loadSpikeGate()).spikeAllowed({
        url: 'file:///app/index.html?spike=plugin-isolation',
        argv: ['/Applications/Continuo.app/Contents/MacOS/Continuo', '--spike'],
        packaged: true,
      }),
    ).toEqual({ allowed: true, reason: 'env-opt-in' });
  });

  it('does not wire did-frame-navigate because top-level will-navigate/guardOpen are the intended gates', async () => {
    const on = vi.fn();

    const unsubscribe = (await loadSpikeGate()).installSpikeGate({ on }, true);

    expect(on.mock.calls.map(([event]) => event)).toEqual(['will-navigate', 'will-frame-navigate']);
    expect(on.mock.calls.map(([event]) => event)).not.toContain('did-frame-navigate');
    expect(typeof unsubscribe).toBe('function');
  });
});
