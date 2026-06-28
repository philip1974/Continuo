import { existsSync, readFileSync } from 'node:fs';
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
  parseDevRendererUrl(rawUrl: string | undefined): URL | null;
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

  it('stripSpikeQuery gate closed 时单趟 for-in,不通过 Object.entries 物化中间数组', async () => {
    const entriesSpy = vi.spyOn(Object, 'entries');
    try {
      expect(
        (await loadSpikeGate()).stripSpikeQuery(
          { spike: 'plugin-isolation', spikeAck: '1', workspace: '/foo' },
          false,
        ),
      ).toEqual({ workspace: '/foo' });
      expect(entriesSpy).not.toHaveBeenCalled();
    } finally {
      entriesSpy.mockRestore();
    }
  });

  it('stripSpikeQuery keeps spike query when gate is open', async () => {
    expect(
      (await loadSpikeGate()).stripSpikeQuery({ spike: 'plugin-isolation', workspace: '/foo' }, true),
    ).toEqual({ spike: 'plugin-isolation', workspace: '/foo' });
  });

  // 边界(E299):dev 渲染 URL 解析 total —— 合法 → URL;缺失/畸形 env → null(调用方回退 loadFile,
  // 不让 new URL 同步抛崩溃 createMainWindow)。
  it('E299 parseDevRendererUrl: 合法 URL → URL 实例', async () => {
    const u = (await loadSpikeGate()).parseDevRendererUrl('http://localhost:5173/');
    expect(u).toBeInstanceOf(URL);
    expect(u?.host).toBe('localhost:5173');
  });

  it('E299 parseDevRendererUrl: 缺失/畸形 env → null,不抛', async () => {
    const m = await loadSpikeGate();
    expect(m.parseDevRendererUrl(undefined)).toBeNull();
    expect(m.parseDevRendererUrl('')).toBeNull();
    expect(() => m.parseDevRendererUrl('not a url ::: %%%')).not.toThrow();
    expect(m.parseDevRendererUrl('not a url ::: %%%')).toBeNull();
  });

  // 边界(E302):parse 前先限长 —— 超 8192 的合法 scheme URL 也返 null(parse-before-cap 一致性)。
  it('E302 parseDevRendererUrl: 超长 URL(> 8192)→ null(new URL 前限长)', async () => {
    const m = await loadSpikeGate();
    const huge = 'http://localhost:5173/' + 'a'.repeat(9000);
    expect(m.parseDevRendererUrl(huge)).toBeNull();
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

  it('createMainWindow dev URL query 注入不通过 Object.entries(queryParts) 物化中间数组', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'electron/main/index.ts'),
      'utf8',
    );

    expect(src).not.toContain('Object.entries(queryParts)');
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

  it('dev 模式先按 packaged 短路,不扫描 argv/url', async () => {
    const argv = ['--spike'];
    Object.defineProperty(argv, 0, {
      get() {
        throw new Error('E310 regression: dev mode should not scan argv');
      },
    });

    expect(
      (await loadSpikeGate()).spikeAllowed({
        url: 'http://localhost:5173/?spike=plugin-isolation',
        argv,
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

  it('packaged 已 opt-in 时不再扫描 url query', async () => {
    const m = await loadSpikeGate();
    const charSpy = vi.spyOn(String.prototype, 'charCodeAt').mockImplementation(() => {
      throw new Error('E310 regression: opt-in should not scan url');
    });
    try {
      expect(
        m.spikeAllowed({
          url: 'file:///app/index.html?spike=plugin-isolation',
          argv: ['CONTINUO_SPIKE=1'],
          packaged: true,
        }),
      ).toEqual({ allowed: true, reason: 'env-opt-in' });
    } finally {
      charSpy.mockRestore();
    }
  });

  it('packaged 已通过 env opt-in 时不扫描 argv', async () => {
    process.env.CONTINUO_SPIKE = '1';
    const argv = ['--spike'];
    Object.defineProperty(argv, 0, {
      get() {
        throw new Error('E310 regression: env opt-in should not scan argv');
      },
    });

    expect(
      (await loadSpikeGate()).spikeAllowed({
        url: 'file:///app/index.html?spike=plugin-isolation',
        argv,
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

  // 边界(E191):超长导航 URL 不跑正则(O(N) 扫描),视为无 spike query → packaged 下仍拦(env-missing),
  // 不会因超长 url 含 spike= 而走 packaged-blocked 分支的全量扫描;dev 仍放行(导航不受影响)。
  it('E191 packaged 超长 url(含 spike=)→ 不扫描正则,reason env-missing(不 packaged-blocked)', async () => {
    const longUrl = `file:///app/index.html?spike=x&pad=${'a'.repeat(9000)}`;
    expect(
      (await loadSpikeGate()).spikeAllowed({
        url: longUrl,
        argv: [],
        packaged: true,
      }),
    ).toEqual({ allowed: false, reason: 'env-missing' });
  });

  it('E191 上限内 url 含 spike= → 仍 packaged-blocked(回归,正则照常)', async () => {
    expect(
      (await loadSpikeGate()).spikeAllowed({
        url: 'file:///app/index.html?spike=x',
        argv: [],
        packaged: true,
      }),
    ).toEqual({ allowed: false, reason: 'packaged-blocked' });
  });

  it('E191 spike query 检测走字符扫描,不调用 RegExp.test', async () => {
    const m = await loadSpikeGate();
    const testSpy = vi.spyOn(RegExp.prototype, 'test');
    try {
      expect(
        m.spikeAllowed({
          url: 'file:///app/index.html?x=1&spike=x',
          argv: [],
          packaged: true,
        }),
      ).toEqual({ allowed: false, reason: 'packaged-blocked' });
      expect(
        m.spikeAllowed({
          url: 'file:///app/index.html?x=1&spikeX=x',
          argv: [],
          packaged: true,
        }),
      ).toEqual({ allowed: false, reason: 'env-missing' });
      expect(testSpy).not.toHaveBeenCalled();
    } finally {
      testSpy.mockRestore();
    }
  });

  it('E191 guardNav 超长 url 阻止时日志只记截断摘要(不写完整 url)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const longUrl = `file:///app/index.html?pad=${'a'.repeat(9000)}`;
    (await loadSpikeGate()).guardNav(
      { preventDefault: () => undefined },
      longUrl,
      true,
    );
    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('…');
    expect(logged).not.toContain('a'.repeat(300)); // 不写完整超长 url
    warn.mockRestore();
  });

  it('does not wire did-frame-navigate because top-level will-navigate/guardOpen are the intended gates', async () => {
    const on = vi.fn();

    const unsubscribe = (await loadSpikeGate()).installSpikeGate({ on }, true);

    expect(on.mock.calls.map(([event]) => event)).toEqual(['will-navigate', 'will-frame-navigate']);
    expect(on.mock.calls.map(([event]) => event)).not.toContain('did-frame-navigate');
    expect(typeof unsubscribe).toBe('function');
  });
});
