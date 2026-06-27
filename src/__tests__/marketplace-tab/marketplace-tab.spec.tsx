// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, waitFor, act } from '@testing-library/react';

vi.mock('../../marketplace/fetcher', () => ({
  fetchMarketplaceIndex: vi.fn(),
  fetchPluginManifest: vi.fn().mockResolvedValue({
    id: '_',
    name: '_',
    version: '0.0.0',
  }),
}));

vi.mock('../../plugins/PluginManager', () => ({
  getUserPluginManager: vi.fn(),
  setUserPluginManager: vi.fn(),
}));

import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import {
  MarketplaceTab,
  marketplaceReviewSortButtonClassName,
  marketplaceTagButtonClassName,
} from '../../marketplace/MarketplaceTab';
import { setLocale as setI18nLocale } from '@/i18n';
import { fetchMarketplaceIndex, fetchPluginManifest } from '../../marketplace/fetcher';
import { getUserPluginManager } from '../../plugins/PluginManager';
import { useUpdateStore } from '../../marketplace/update-store';
import { useReviewsStore } from '../../marketplace/reviews-store';
import type { MarketplaceEntry } from '../../marketplace/types';

const fetchIndexMock = fetchMarketplaceIndex as unknown as ReturnType<typeof vi.fn>;
const fetchManifestMock = fetchPluginManifest as unknown as ReturnType<typeof vi.fn>;
const getMgr = getUserPluginManager as unknown as ReturnType<typeof vi.fn>;

function entry(over: Partial<MarketplaceEntry> & { id: string }): MarketplaceEntry {
  const base: MarketplaceEntry = {
    id: over.id,
    name: over.id,
    description: 'd',
    author: 'me',
    repo: `me/${over.id}`,
    branch: 'main',
    tags: [],
    verified: false,
  };
  return { ...base, ...over };
}

function installApi(installFromGit: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'api', {
    value: { plugins: { installFromGit } },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  fetchIndexMock.mockReset();
  // 还原全局默认:远程 manifest 版本 0.0.0(各 test 默认不触发"有更新")
  fetchManifestMock.mockReset();
  fetchManifestMock.mockResolvedValue({ id: '_', name: '_', version: '0.0.0' });
  getMgr.mockReset();
  useUpdateStore.setState({
    available: [],
    remoteVersions: new Map(),
    checking: false,
    lastCheckedAt: null,
  });
  useReviewsStore.setState({
    byPid: new Map(),
    loading: false,
    error: null,
    lastFetchedAt: null,
  });
});

describe('MarketplaceTab — className helpers', () => {
  it('tag/sort toggle className 不通过数组 join 重建', () => {
    const joinSpy = vi.spyOn(Array.prototype, 'join');

    try {
      expect(marketplaceTagButtonClassName(true)).toContain(
        'border-accent bg-accent text-canvas',
      );
      expect(marketplaceTagButtonClassName(false)).toContain(
        'border-line bg-panel text-fg-muted hover:bg-hover hover:text-fg',
      );
      expect(marketplaceReviewSortButtonClassName(true)).toContain(
        'bg-accent/20 text-accent',
      );
      expect(marketplaceReviewSortButtonClassName(false)).toContain(
        'hover:bg-hover',
      );
      expect(joinSpy).not.toHaveBeenCalled();
    } finally {
      joinSpy.mockRestore();
    }
  });
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('MarketplaceTab — load 状态', () => {
  it('loading → 显示 spinner', () => {
    fetchIndexMock.mockReturnValue(new Promise(() => {})); // 永不 resolve
    installApi(vi.fn());
    const { container } = render(<MarketplaceTab />);
    // Spinner 是个 svg / div,我们检查它存在(没有具体卡片)
    expect(container.textContent).not.toContain('显示');
  });

  // a11y(A104,I16 升级):初始加载态从「Spinner 泛化 aria-label」升级为 role=status 容器播报
  // 具体「正在加载插件市场」文本(Spinner aria-hidden)。locale=zh 断言具体加载文案在 live region。
  it('a11y · 初始加载 → role=status 播报具体加载文本 + Spinner aria-hidden', () => {
    setI18nLocale('zh');
    try {
      fetchIndexMock.mockReturnValue(new Promise(() => {}));
      installApi(vi.fn());
      const { container } = render(<MarketplaceTab />);
      const status = container.querySelector('[role="status"]');
      expect(status).not.toBeNull();
      expect(status!.textContent).toContain('正在加载插件市场');
      // Spinner 标 aria-hidden,不再泛化 Loading 双播报
      expect(status!.querySelector('[aria-hidden="true"]')).not.toBeNull();
    } finally {
      setI18nLocale('zh');
    }
  });

  it('error → 「✘ 拉取索引失败」', async () => {
    fetchIndexMock.mockRejectedValue(new Error('offline'));
    installApi(vi.fn());
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('拉取索引失败');
      expect(container.textContent).toContain('offline');
    });
  });

  // a11y(A66,A41 同族):索引异步加载失败块须 live region(失败=role=alert),焦点在面板/搜索
  // 入口时也能主动播报,否则 SR 用户只感知"无内容"不知是加载失败。
  it('a11y · 索引加载失败 → 错误块在 role=alert', async () => {
    fetchIndexMock.mockRejectedValue(new Error('offline'));
    installApi(vi.fn());
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      const alert = container.querySelector('[role=alert]');
      expect(alert).not.toBeNull();
      expect(alert!.textContent).toContain('拉取索引失败');
    });
  });

  // i18n(I5):fetcher 对可本地化失败抛稳定 code(MARKETPLACE_INDEX_INVALID),
  // MarketplaceTab 按 errors.<CODE> catalog 渲染。locale=en 显英文,不泄漏中文。
  it('index 加载失败 code 在 catalog + locale=en → 英文文案,不泄漏中文', async () => {
    setI18nLocale('en');
    try {
      fetchIndexMock.mockRejectedValue(new Error('MARKETPLACE_INDEX_INVALID'));
      installApi(vi.fn());
      const { container } = render(<MarketplaceTab />);
      await waitFor(() => {
        // en catalog: 'Remote index is not a valid array'
        expect(container.textContent).toContain('not a valid array');
      });
      expect(container.textContent).not.toContain('数组');
    } finally {
      setI18nLocale('zh');
    }
  });

  // 网络/HTTP 等动态错误无 catalog → 回退原 message(既有行为保持)。
  it('index 加载失败 code 不在 catalog(网络错)→ 回退原 message', async () => {
    fetchIndexMock.mockRejectedValue(new Error('Failed to fetch'));
    installApi(vi.fn());
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('Failed to fetch');
    });
  });

  it('ok 但 entries 空 → 「暂无插件」+ 仓库链接', async () => {
    fetchIndexMock.mockResolvedValue([]);
    installApi(vi.fn());
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('暂无插件');
    });
  });

  // a11y(A67,A56/A66 同族):加载成功但为空也是异步结果,焦点在原控件时须 role=status 播报。
  it('a11y · 索引为空 → 空态在 role=status', async () => {
    fetchIndexMock.mockResolvedValue([]);
    installApi(vi.fn());
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      const status = container.querySelector('[role=status]');
      expect(status).not.toBeNull();
      expect(status!.textContent).toContain('暂无插件');
    });
  });
});

describe('MarketplaceTab — 列表 + 计数', () => {
  it('ok + 多 entries → 渲染卡片 + 「显示 N / 共 M」', async () => {
    fetchIndexMock.mockResolvedValue([
      entry({ id: 'a', name: 'A', tags: ['ui'] }),
      entry({ id: 'b', name: 'B', tags: ['lang'] }),
    ]);
    installApi(vi.fn());
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('A');
      expect(container.textContent).toContain('B');
    });
    expect(container.textContent).toMatch(/显示\s*2\s*\/\s*共\s*2/);
    // a11y(A55):结果摘要(shown/total)须在 live region(role=status)播报筛选数量变化。
    const statuses = Array.from(container.querySelectorAll('[role=status]'));
    expect(statuses.some((s) => /显示\s*2\s*\/\s*共\s*2/.test(s.textContent ?? ''))).toBe(
      true,
    );
  });

  it('读取已安装 id 时不对 listAll 快照先 map 成中间数组', async () => {
    const installedSnapshot = [
      { id: 'a', manifest: { id: 'a', name: 'A', version: '1.0.0' } },
    ];
    getMgr.mockReturnValue({ listAll: () => installedSnapshot });
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    installApi(vi.fn());

    const mapSpy = vi.spyOn(Array.prototype, 'map');
    try {
      const { container } = render(<MarketplaceTab />);
      await waitFor(() => {
        expect(container.textContent).toContain('A');
      });
      const mapCallsOnInstalled = mapSpy.mock.contexts.filter(
        (ctx) => ctx === installedSnapshot,
      ).length;
      expect(mapCallsOnInstalled).toBe(0);
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('构建更新版本索引时不对 available updates 先 map 成中间数组', async () => {
    const updatesSnapshot = [
      {
        id: 'a',
        name: 'A',
        from: '1.0.0',
        to: '2.0.0',
        entry: entry({ id: 'a', name: 'A' }),
      },
    ];
    useUpdateStore.setState({ available: updatesSnapshot });
    getMgr.mockReturnValue({
      listAll: () => [
        { id: 'a', manifest: { id: 'a', name: 'A', version: '1.0.0' } },
      ],
    });
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    installApi(vi.fn());

    const mapSpy = vi.spyOn(Array.prototype, 'map');
    try {
      const { container } = render(<MarketplaceTab />);
      await waitFor(() => {
        expect(container.textContent).toContain('更新到 v2.0.0');
      });
      const mapCallsOnUpdates = mapSpy.mock.contexts.filter(
        (ctx) => ctx === updatesSnapshot,
      ).length;
      expect(mapCallsOnUpdates).toBe(0);
    } finally {
      mapSpy.mockRestore();
    }
  });

  // a11y(A3,A1 同族):Marketplace 搜索框须有 aria-label 可访问名(屏幕阅读器),
  // placeholder 无参数 → 复用作 aria-label。locale-无关:aria-label 非空且 == placeholder。
  it('a11y · Marketplace 搜索 Input 有 aria-label 可访问名', async () => {
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    installApi(vi.fn());
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('A');
    });
    const input = container.querySelector(
      'input[placeholder^="搜索插件"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    const ariaLabel = input.getAttribute('aria-label') ?? '';
    expect(ariaLabel.length).toBeGreaterThan(0);
    expect(ariaLabel).toBe(input.getAttribute('placeholder'));
  });

  it('搜索过滤 → 减少卡片', async () => {
    fetchIndexMock.mockResolvedValue([
      entry({ id: 'foo', name: 'Foo Plugin' }),
      entry({ id: 'bar', name: 'Bar Plugin' }),
    ]);
    installApi(vi.fn());
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('Foo Plugin');
    });
    const input = container.querySelector(
      'input[placeholder^="搜索插件"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'foo' } });
    expect(container.textContent).toContain('Foo Plugin');
    expect(container.textContent).not.toContain('Bar Plugin');
  });

  // a11y(A72,A70 同族装饰符号):卡片仓库外链的 ↗ 须 aria-hidden,不混进链接可访问名。
  it('a11y · 卡片仓库外链 ↗ 在 aria-hidden span 内', async () => {
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    installApi(vi.fn());
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('A');
    });
    const repoLink = container.querySelector(
      'a[href="https://github.com/me/a"]',
    ) as HTMLAnchorElement | null;
    expect(repoLink).not.toBeNull();
    expect(repoLink!.textContent).toContain('me/a');
    const arrow = Array.from(repoLink!.querySelectorAll('span')).find((s) =>
      (s.textContent ?? '').includes('↗'),
    );
    expect(arrow).toBeTruthy();
    expect(arrow!.getAttribute('aria-hidden')).toBe('true');
  });

  it('过滤后空 → 「没有匹配的插件」', async () => {
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    installApi(vi.fn());
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('A');
    });
    const input = container.querySelector(
      'input[placeholder^="搜索插件"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(container.textContent).toContain('没有匹配的插件');
  });

  it('tag 过滤 + 清除按钮', async () => {
    fetchIndexMock.mockResolvedValue([
      entry({ id: 'a', name: 'A', tags: ['ui'] }),
      entry({ id: 'b', name: 'B', tags: ['lang'] }),
    ]);
    installApi(vi.fn());
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('A');
    });
    // 找到 tag 按钮(包含 'ui' 文本)并点击
    const uiTagBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.trim() === 'ui')!;
    expect(uiTagBtn).toBeDefined();
    // a11y(A8):tag filter toggle 须用 aria-pressed 暴露选中态(active 只改 className)。
    expect(uiTagBtn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(uiTagBtn);
    expect(uiTagBtn.getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('A');
    expect(container.textContent).not.toContain('B');

    // 清除按钮出现
    const clearBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '清除筛选')!;
    fireEvent.click(clearBtn);
    expect(container.textContent).toContain('B');
  });

  // a11y(A98,A97 同族):Popular tags 筛选组须 role=group + aria-labelledby 关联组名。
  it('a11y · tag 筛选组有 role=group + aria-labelledby 关联 Popular tags 标签', async () => {
    fetchIndexMock.mockResolvedValue([
      entry({ id: 'a', name: 'A', tags: ['ui'] }),
      entry({ id: 'b', name: 'B', tags: ['lang'] }),
    ]);
    installApi(vi.fn());
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => expect(container.textContent).toContain('A'));
    const group = container.querySelector('[role=group][aria-labelledby]');
    expect(group).not.toBeNull();
    const labelId = group!.getAttribute('aria-labelledby')!;
    const label = container.querySelector(`[id="${labelId}"]`);
    expect(label).not.toBeNull();
    expect((label!.textContent ?? '').length).toBeGreaterThan(0);
    // tag toggle 按钮在该组内
    expect(group!.querySelectorAll('button[aria-pressed]').length).toBeGreaterThan(0);
  });
});

describe('MarketplaceTab — 安装按钮', () => {
  // a11y(A94,A93 同族):卡片安装 loading 须 aria-busy + 视觉隐藏 role=status 播报「安装中」。
  it('a11y · 卡片安装 loading → 按钮 aria-busy + role=status 播报安装中', async () => {
    // 永不 resolve → 保持 installing 态
    const installFromGit = vi.fn().mockReturnValue(new Promise(() => {}));
    installApi(installFromGit);
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => expect(container.textContent).toContain('A'));
    const installBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '安装')!;
    fireEvent.click(installBtn);
    await waitFor(() => {
      const busyBtn = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.getAttribute('aria-busy') === 'true');
      expect(busyBtn).toBeDefined();
    });
    const statuses = Array.from(container.querySelectorAll('[role=status]'));
    expect(statuses.some((s) => (s.textContent ?? '').includes('安装中'))).toBe(true);
  });

  // race(R8):卡片安装 handler 须同步 in-flight 闸门 —— 同一事件循环内双击(render disabled 尚未
  // 生效)不得启动两次 installFromGit(主进程双 clone,第二个 EEXIST 覆盖成功为失败)。
  it('R8 卡片安装同 tick 双击 → installFromGit 只调一次(同步单飞)', async () => {
    const installFromGit = vi.fn().mockReturnValue(new Promise(() => {})); // 永不 resolve,保持 busy
    installApi(installFromGit);
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => expect(container.textContent).toContain('A'));
    const installBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '安装')!;
    // 单 act 内连续两次 raw click:中间不 flush re-render → disabled 尚未生效,两次 onClick 都派发。
    await act(async () => {
      installBtn.click();
      installBtn.click();
    });
    expect(installFromGit).toHaveBeenCalledTimes(1);
  });

  // a11y(A93,A51 同族):reviews 刷新 loading 是瞬时状态,须 aria-busy + 视觉隐藏 role=status 播报。
  it('a11y · reviews 刷新 loading → 按钮 aria-busy + role=status 播报刷新中', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => expect(container.textContent).toContain('A'));
    // 直接置 reviews loading 态(模拟刷新进行中)
    act(() => {
      useReviewsStore.setState({ loading: true });
    });
    const refreshBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => (b.getAttribute('title') ?? '').includes('重新拉评分'));
    expect(refreshBtn!.getAttribute('aria-busy')).toBe('true');
    // 视觉隐藏 role=status 输出「刷新中」
    const statuses = Array.from(container.querySelectorAll('[role=status]'));
    expect(statuses.some((s) => (s.textContent ?? '').includes('刷新中'))).toBe(true);
  });

  // a11y(A92,A88 同族):maintainer badge 的 🛡 catalog 已去符号,JSX 用 aria-hidden span 渲染。
  it('a11y · maintainer badge 🛡 在 aria-hidden span(可读文本无符号)', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    getMgr.mockReturnValue({ listAll: () => [] });
    act(() => {
      useReviewsStore.setState({
        loading: false,
        error: null,
        byPid: new Map([
          [
            'a',
            {
              pluginId: 'a',
              count: 1,
              avg: 5,
              reviews: [
                {
                  pluginId: 'a',
                  rating: 5,
                  body: 'hi',
                  author: { handle: 'philip1974', avatarUrl: '', createdAt: '2000-01-01' },
                  url: 'https://x/1',
                  createdAt: '2020-01-01',
                  thumbsUp: 0,
                },
              ],
            },
          ],
        ]),
      });
    });
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => expect(container.textContent).toContain('A'));
    fireEvent.click(
      container.querySelector('button[aria-expanded]') as HTMLButtonElement,
    );
    const shield = Array.from(
      container.querySelectorAll('span[aria-hidden="true"]'),
    ).find((s) => (s.textContent ?? '').includes('🛡'));
    expect(shield).toBeTruthy();
    expect(container.textContent).toContain('维护者');
  });

  // a11y(A91):new-account badge 的 ⚠ aria-hidden + 风险说明从 title-only 改视觉隐藏可读文本。
  it('a11y · new-account badge ⚠ 隐藏 + 风险说明可被 AT 读取', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    getMgr.mockReturnValue({ listAll: () => [] });
    act(() => {
      useReviewsStore.setState({
        loading: false,
        error: null,
        byPid: new Map([
          [
            'a',
            {
              pluginId: 'a',
              count: 1,
              avg: 5,
              reviews: [
                {
                  pluginId: 'a',
                  rating: 5,
                  body: 'hi',
                  // 未来日期 → accountAge 负 → isNewAccount=true(确定性,不依赖当前时间精度)
                  author: { handle: 'newbie', avatarUrl: '', createdAt: '2099-01-01' },
                  url: 'https://x/1',
                  createdAt: '2099-01-01',
                  thumbsUp: 0,
                },
              ],
            },
          ],
        ]),
      });
    });
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => expect(container.textContent).toContain('A'));
    fireEvent.click(
      container.querySelector('button[aria-expanded]') as HTMLButtonElement,
    );
    // badge 容器:含 ⚠ 的 aria-hidden span
    const hiddenWarn = Array.from(
      container.querySelectorAll('span[aria-hidden="true"]'),
    ).find((s) => (s.textContent ?? '').includes('⚠'));
    expect(hiddenWarn).toBeTruthy();
    // 风险说明文本(账号天数)在 DOM 可被 AT 读取(zh: 含「天」)
    expect(container.textContent).toMatch(/天|days|일/);
  });

  // 边界(E270,E253 续 / 信任信号防绕过):author.createdAt 不可解析为日期(如 "not-a-date")→ getTime()
  // 为 NaN → 旧实现 `NaN < NEW_ACCOUNT_MS` 为 false → 新账号 badge 被静默绕过。保守视为新账号 → 仍显 ⚠ badge。
  it('E270 author.createdAt 不可解析 → 仍显新账号 ⚠ badge(不被绕过)', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    getMgr.mockReturnValue({ listAll: () => [] });
    act(() => {
      useReviewsStore.setState({
        loading: false,
        error: null,
        byPid: new Map([
          [
            'a',
            {
              pluginId: 'a',
              count: 1,
              avg: 5,
              reviews: [
                {
                  pluginId: 'a',
                  rating: 5,
                  body: 'hi',
                  // 不可解析日期 → getTime() NaN → 保守视为新账号(防绕过)
                  author: { handle: 'newbie', avatarUrl: '', createdAt: 'not-a-date' },
                  url: 'https://x/1',
                  createdAt: '2020-01-01',
                  thumbsUp: 0,
                },
              ],
            },
          ],
        ]),
      });
    });
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => expect(container.textContent).toContain('A'));
    fireEvent.click(
      container.querySelector('button[aria-expanded]') as HTMLButtonElement,
    );
    const hiddenWarn = Array.from(
      container.querySelectorAll('span[aria-hidden="true"]'),
    ).find((s) => (s.textContent ?? '').includes('⚠'));
    expect(hiddenWarn).toBeTruthy(); // 不可解析 createdAt 仍触发 badge
  });

  // a11y(A90,A88 同族):刷新评分按钮文本含装饰 ⟳,catalog 已去符号,⟳ 在 aria-hidden span。
  it('a11y · 刷新评分按钮 ⟳ 在 aria-hidden span(可访问名无符号)', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('A');
    });
    const refreshBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => (b.getAttribute('title') ?? '').includes('重新拉评分'));
    expect(refreshBtn).toBeDefined();
    const icon = refreshBtn!.querySelector('span[aria-hidden="true"]');
    expect(icon).not.toBeNull();
    expect(icon!.textContent).toContain('⟳');
    // 文本节点(刷新评分)不带符号
    expect(refreshBtn!.textContent).toContain('刷新评分');
  });

  // a11y(A79,A77 同族):多卡片 review 链接可见文本通用(写评论/写第一条),aria-label 须含插件名。
  it('a11y · 卡片 review 链接 aria-label 含插件名(多卡片可区分)', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([
      entry({ id: 'a', name: 'Foo' }),
      entry({ id: 'b', name: 'Bar' }),
    ]);
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('Foo');
    });
    const linkLabels = Array.from(container.querySelectorAll('a'))
      .map((a) => a.getAttribute('aria-label') ?? '')
      .filter(Boolean);
    expect(linkLabels.some((l) => l.includes('Foo'))).toBe(true);
    expect(linkLabels.some((l) => l.includes('Bar'))).toBe(true);
    // a11y(A88):aria-label 用纯文本 catalog,不含装饰 ✏️/↗(符号在 JSX aria-hidden 渲染)。
    for (const l of linkLabels) {
      expect(l).not.toContain('✏️');
      expect(l).not.toContain('↗');
    }
  });

  // a11y(A81,A79 同族):Reviews 展开区「See all in GitHub」链接多卡片同名,aria-label 须含插件名。
  it('a11y · See all in GitHub 链接 aria-label 含插件名', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'Foo' })]);
    getMgr.mockReturnValue({ listAll: () => [] });
    const reviews = Array.from({ length: 11 }, (_, i) => ({
      pluginId: 'a',
      rating: 5,
      body: 'b' + i,
      author: { handle: 'u', avatarUrl: '', createdAt: '2020-01-01' },
      url: 'https://x/' + i,
      createdAt: '2020-01-01',
      thumbsUp: 0,
    }));
    act(() => {
      useReviewsStore.setState({
        loading: false,
        error: null,
        byPid: new Map([['a', { pluginId: 'a', count: 11, avg: 5, reviews }]]),
      });
    });
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('Foo');
    });
    const expandBtn = container.querySelector(
      'button[aria-expanded]',
    ) as HTMLButtonElement;
    fireEvent.click(expandBtn);
    const seeAll = Array.from(container.querySelectorAll('a')).find(
      (a) =>
        (a.getAttribute('aria-label') ?? '').includes('Foo') &&
        (a.getAttribute('href') ?? '').includes('discussions'),
    );
    expect(seeAll).toBeTruthy();
  });

  // a11y(A77,A75 同族):多卡片安装按钮可见文本通用(都叫「安装」),aria-label 须含插件名以区分。
  it('a11y · 卡片安装按钮 aria-label 含插件名(多卡片可区分)', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([
      entry({ id: 'a', name: 'Foo' }),
      entry({ id: 'b', name: 'Bar' }),
    ]);
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('Foo');
    });
    const installLabels = Array.from(container.querySelectorAll('button'))
      .map((b) => b.getAttribute('aria-label') ?? '')
      .filter((l) => l.includes('安装'));
    expect(installLabels.some((l) => l.includes('Foo'))).toBe(true);
    expect(installLabels.some((l) => l.includes('Bar'))).toBe(true);
  });

  it('未装 → 显「安装」,点击调 installFromGit + pending', async () => {
    const installFromGit = vi.fn().mockResolvedValue({
      ok: true,
      data: { id: 'a', name: 'A', version: '1.0.0' },
    });
    installApi(installFromGit);
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('A');
    });
    const installBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '安装')!;
    expect(installBtn).toBeDefined();
    fireEvent.click(installBtn);
    await waitFor(() => {
      expect(installFromGit).toHaveBeenCalledWith(
        'https://github.com/me/a.git',
      );
    });
    await waitFor(() => {
      expect(container.textContent).toContain('已安装 A v1.0.0');
    });
    // a11y(A44):卡片安装成功结果须 live region(成功=role=status)主动播报。
    const statuses = Array.from(container.querySelectorAll('[role=status]'));
    const okStatus = statuses.find((s) => (s.textContent ?? '').includes('已安装 A'));
    expect(okStatus).toBeTruthy();
    // a11y(A87):成功 catalog 已去装饰 ✔,status 播报不含 check mark 噪声。
    expect(okStatus!.textContent).not.toContain('✔');
  });

  it('install ok=false → 「[code] message」(catalog 已去 ✘)', async () => {
    const installFromGit = vi.fn().mockResolvedValue({
      ok: false,
      code: 'CLONE_FAILED',
      message: 'auth required',
    });
    installApi(installFromGit);
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('A');
    });
    fireEvent.click(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent === '安装')!,
    );
    await waitFor(() => {
      expect(container.textContent).toContain('CLONE_FAILED');
    });
    // a11y(A44):卡片安装失败结果须 live region(失败=role=alert)主动播报。
    const alerts = Array.from(container.querySelectorAll('[role=alert]'));
    expect(
      alerts.some((a) => (a.textContent ?? '').includes('CLONE_FAILED')),
    ).toBe(true);
  });

  // i18n(codex 复查 P1,I1 同族):installFromGit 失败 message 是 main 硬编码中文,经 IPC
  // 原样回传。Marketplace 卡片须按稳定 r.code 经 catalog 翻译,catalog 命中时 en/ko 不得
  // 泄漏中文。(同族兄弟:卡片安装 / 卡片更新 / Git URL 安装段 三处入口。)
  it('install 失败 code 在 catalog(BAD_URL)+ locale=en → 英文文案,不泄漏中文', async () => {
    setI18nLocale('en');
    try {
      const installFromGit = vi.fn().mockResolvedValue({
        ok: false,
        code: 'BAD_URL',
        message: '不支持的 git URL: ftp://x', // main 硬编码中文
      });
      installApi(installFromGit);
      fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
      const { container } = render(<MarketplaceTab />);
      await waitFor(() => {
        expect(container.textContent).toContain('A');
      });
      fireEvent.click(
        Array.from(
          container.querySelectorAll<HTMLButtonElement>('button'),
        ).find((b) => b.textContent === 'Install')!,
      );
      await waitFor(() => {
        // en catalog: install_failed_code = '✘ Install failed [{code}] {message}',
        // errors.BAD_URL = 'Bad URL'
        expect(container.textContent).toContain('Bad URL');
      });
      expect(container.textContent).not.toContain('不支持的 git URL');
      expect(container.textContent).toContain('BAD_URL');
    } finally {
      setI18nLocale('zh');
    }
  });

  // a11y(A85):catch 路径 message 不再拼装饰性 ✘(severity 由 isError+role=alert 表达)。
  it('install 抛 → message 含 err 且不含装饰 ✘', async () => {
    const installFromGit = vi.fn().mockRejectedValue(new Error('boom'));
    installApi(installFromGit);
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('A');
    });
    fireEvent.click(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent === '安装')!,
    );
    await waitFor(() => {
      expect(container.textContent).toContain('boom');
    });
    // 失败提示在 role=alert,但文本不含装饰 ✘
    const alert = Array.from(container.querySelectorAll('[role=alert]')).find((a) =>
      (a.textContent ?? '').includes('boom'),
    );
    expect(alert).toBeTruthy();
    expect(alert!.textContent).not.toContain('✘');
  });
});

describe('MarketplaceTab — 更新按钮', () => {
  // 审计 #2: 更新改为原子覆盖安装(overwrite=true),不再先卸载 —— 卸载成功但
  // 重装失败会丢插件。这里断言点更新不调 uninstall,且 installFromGit 带 overwrite。
  it('updateStore 中有 entry → 显「更新」按钮 → 原子覆盖安装(不卸载)', async () => {
    const installFromGit = vi.fn().mockResolvedValue({
      ok: true,
      data: { id: 'a', name: 'A', version: '2.0.0' },
    });
    installApi(installFromGit);
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    const uninstall = vi.fn().mockResolvedValue(undefined);
    getMgr.mockReturnValue({
      listAll: () => [
        { id: 'a', manifest: { id: 'a', name: 'A', version: '1.0.0' } },
      ],
      uninstall,
      reload: vi.fn().mockResolvedValue(undefined),
    });
    useUpdateStore.setState({
      available: [
        {
          id: 'a',
          name: 'A',
          from: '1.0.0',
          to: '2.0.0',
          entry: entry({ id: 'a', name: 'A' }),
        },
      ],
    });

    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('A');
    });
    const updateBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.includes('更新'));
    expect(updateBtn).toBeDefined();
    fireEvent.click(updateBtn!);
    await waitFor(() => {
      expect(installFromGit).toHaveBeenCalledWith(expect.any(String), true);
    });
    // 关键:更新路径不再卸载,避免重装失败丢插件
    expect(uninstall).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(container.textContent).toContain('更新到 A v2.0.0');
    });
  });

  // 第二十二轮 P2-BB:更新成功后先 reload 本地 PluginManager 版本再 refresh,否则
  // refreshUpdates 读到陈旧旧版本 → 把刚 dismiss 的更新条目又加回 available(复活)。
  it('更新成功 → reload 推进本地版本后 refresh 不复活更新条目', async () => {
    const installFromGit = vi.fn().mockResolvedValue({
      ok: true,
      data: { id: 'a', name: 'A', version: '2.0.0' },
    });
    installApi(installFromGit);
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    // 远程 manifest = 2.0.0(refreshUpdates 比较用)
    fetchManifestMock.mockResolvedValue({ id: 'a', name: 'A', version: '2.0.0' });
    // 本地初始 1.0.0;reload 模拟磁盘已是 2.0.0 → 内存版本推进
    let localVer = '1.0.0';
    const reload = vi.fn().mockImplementation(async () => {
      localVer = '2.0.0';
    });
    getMgr.mockReturnValue({
      listAll: () => [
        { id: 'a', manifest: { id: 'a', name: 'A', version: localVer } },
      ],
      reload,
    });
    useUpdateStore.setState({
      available: [
        {
          id: 'a',
          name: 'A',
          from: '1.0.0',
          to: '2.0.0',
          entry: entry({ id: 'a', name: 'A' }),
        },
      ],
    });

    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('A');
    });
    fireEvent.click(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent?.includes('更新'))!,
    );
    await waitFor(() => {
      expect(reload).toHaveBeenCalledWith('a');
    });
    // refresh 后:本地已 2.0.0 == 远程 2.0.0,非 newer → 不复活
    await waitFor(() => {
      expect(
        useUpdateStore.getState().available.some((u) => u.id === 'a'),
      ).toBe(false);
    });
  });
});

describe('MarketplaceTab — 评论刷新失败反馈', () => {
  // 第二十二轮 P2-BC:刷新评论失败必须给反馈,否则按钮恢复原样 + 评论区无变化 →
  // 用户无法区分"刷新成功无新评论" vs "刷新失败"。旧实现订阅了 loading 却没读 error。
  it('reviews-store.error 非空 → 渲染错误反馈', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    getMgr.mockReturnValue({ listAll: () => [] });
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('A');
    });
    act(() => {
      useReviewsStore.setState({
        loading: false,
        error: 'NO_TOKEN: missing token',
      });
    });
    await waitFor(() => {
      expect(container.textContent).toContain('刷新评分失败');
      expect(container.textContent).toContain('NO_TOKEN');
    });
    // a11y(A41):异步刷新失败须 role=alert(live region)主动播报,焦点仍在按钮时也能听到。
    const alert = container.querySelector('[role=alert]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('NO_TOKEN');
  });

  // i18n(I12,I5 同族):reviews-fetcher 抛稳定 code(MARKETPLACE_REVIEWS_NO_TOKEN),
  // MarketplaceTab 按 errors.<CODE> catalog 本地化。locale=en 显英文,不泄漏中文。
  it('reviews error 为稳定 code + locale=en → 英文 catalog,不泄漏中文', async () => {
    setI18nLocale('en');
    try {
      installApi(vi.fn());
      fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
      getMgr.mockReturnValue({ listAll: () => [] });
      const { container } = render(<MarketplaceTab />);
      await waitFor(() => {
        expect(container.textContent).toContain('A');
      });
      act(() => {
        useReviewsStore.setState({
          loading: false,
          error: 'MARKETPLACE_REVIEWS_NO_TOKEN',
        });
      });
      await waitFor(() => {
        // en catalog: 'GitHub token not configured in the main process'
        expect(container.textContent).toContain('GitHub token not configured');
      });
      expect(container.textContent).not.toContain('未在主进程');
    } finally {
      setI18nLocale('zh');
    }
  });

  // a11y(A9):reviews 展开/折叠按钮须 aria-expanded 暴露当前展开态(原只用 title+▴/▾)。
  it('a11y · reviews 展开按钮有 aria-expanded 随点击切换', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    getMgr.mockReturnValue({ listAll: () => [] });
    act(() => {
      useReviewsStore.setState({
        loading: false,
        error: null,
        byPid: new Map([
          [
            'a',
            {
              pluginId: 'a',
              count: 1,
              avg: 5,
              reviews: [
                {
                  pluginId: 'a',
                  rating: 5,
                  body: 'great',
                  author: { handle: 'u', avatarUrl: '', createdAt: '2020-01-01' },
                  url: 'https://x',
                  createdAt: '2020-01-01',
                  thumbsUp: 0,
                },
              ],
            },
          ],
        ]),
      });
    });
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('A');
    });
    const expandBtn = container.querySelector(
      'button[aria-expanded]',
    ) as HTMLButtonElement | null;
    expect(expandBtn).not.toBeNull();
    expect(expandBtn!.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(expandBtn!);
    expect(expandBtn!.getAttribute('aria-expanded')).toBe('true');
  });

  // 边界(E295):avatarUrl 为空时不渲染 <img src="">。浏览器会把空 src 当作当前页 URL,
  // 触发无意义的页面资源请求/警告;旧缓存或异常 store 数据不应放大成网络副作用。
  it('E295 review avatarUrl 为空 → 不渲染空 src 图片', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    getMgr.mockReturnValue({ listAll: () => [] });
    act(() => {
      useReviewsStore.setState({
        loading: false,
        error: null,
        byPid: new Map([
          [
            'a',
            {
              pluginId: 'a',
              count: 1,
              avg: 5,
              reviews: [
                {
                  pluginId: 'a',
                  rating: 5,
                  body: 'great',
                  author: { handle: 'u', avatarUrl: '', createdAt: '2020-01-01' },
                  url: 'https://x',
                  createdAt: '2020-01-01',
                  thumbsUp: 0,
                },
              ],
            },
          ],
        ]),
      });
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { container } = render(<MarketplaceTab />);
      await waitFor(() => {
        expect(container.textContent).toContain('A');
      });
      fireEvent.click(
        container.querySelector('button[aria-expanded]') as HTMLButtonElement,
      );

      const messages = errorSpy.mock.calls.map((args) => args.join(' '));
      expect(messages.some((m) => m.includes('empty string'))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // a11y(A70,A9 同族):展开状态已由 aria-expanded 暴露,视觉三角 ▴/▾ 须 aria-hidden,
  // 否则混进按钮可访问名造成与 expanded 重复的噪声。
  it('a11y · reviews 展开按钮三角 ▴/▾ 标 aria-hidden', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    getMgr.mockReturnValue({ listAll: () => [] });
    act(() => {
      useReviewsStore.setState({
        loading: false,
        error: null,
        byPid: new Map([
          [
            'a',
            {
              pluginId: 'a',
              count: 1,
              avg: 5,
              reviews: [
                {
                  pluginId: 'a',
                  rating: 5,
                  body: 'great',
                  author: { handle: 'u', avatarUrl: '', createdAt: '2020-01-01' },
                  url: 'https://x',
                  createdAt: '2020-01-01',
                  thumbsUp: 0,
                },
              ],
            },
          ],
        ]),
      });
    });
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('A');
    });
    const expandBtn = container.querySelector(
      'button[aria-expanded]',
    ) as HTMLButtonElement;
    // 折叠态:三角 ▾ 在 aria-hidden span 内
    const tri = Array.from(expandBtn.querySelectorAll('span')).find((s) =>
      /[▴▾]/.test(s.textContent ?? ''),
    );
    expect(tri).toBeTruthy();
    expect(tri!.getAttribute('aria-hidden')).toBe('true');
    // 展开后符号切换为 ▴ 且仍 aria-hidden
    fireEvent.click(expandBtn);
    const tri2 = Array.from(expandBtn.querySelectorAll('span')).find((s) =>
      /[▴▾]/.test(s.textContent ?? ''),
    );
    expect(tri2!.textContent).toContain('▴');
    expect(tri2!.getAttribute('aria-hidden')).toBe('true');
  });

  // a11y(A36):ReviewItem 的 GitHub 外链是图标-only(仅 ↗),须有 aria-label 可访问名。
  it('a11y · review GitHub 外链有 aria-label(非仅箭头符号)', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    getMgr.mockReturnValue({ listAll: () => [] });
    act(() => {
      useReviewsStore.setState({
        loading: false,
        error: null,
        byPid: new Map([
          [
            'a',
            {
              pluginId: 'a',
              count: 1,
              avg: 5,
              reviews: [
                {
                  pluginId: 'a',
                  rating: 5,
                  body: 'great',
                  author: { handle: 'u', avatarUrl: '', createdAt: '2020-01-01' },
                  url: 'https://github.com/x/y/discussions/1',
                  createdAt: '2020-01-01',
                  thumbsUp: 0,
                },
              ],
            },
          ],
        ]),
      });
    });
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => expect(container.textContent).toContain('A'));
    fireEvent.click(
      container.querySelector('button[aria-expanded]') as HTMLButtonElement,
    );
    const link = container.querySelector(
      'a[href="https://github.com/x/y/discussions/1"]',
    ) as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect((link.getAttribute('aria-label') ?? '').length).toBeGreaterThan(1); // 非仅 ↗

    // a11y(A38):单条 review 星级须有 aria-label(纯 ★/☆ 符号不可读)。展开后应有聚合 +
    // 单条两处带 aria-label 的星级 span(此前仅聚合 1 处)。
    const starSpans = container.querySelectorAll('.text-amber-400[aria-label]');
    expect(starSpans.length).toBeGreaterThanOrEqual(2);
  });

  // a11y(A83,A79 同族):多条 review 的 GitHub 外链须靠作者上下文区分(否则全是 open_in_github)。
  it('a11y · review GitHub 外链 aria-label 含作者(多条可区分)', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    getMgr.mockReturnValue({ listAll: () => [] });
    const mk = (handle: string, url: string) => ({
      pluginId: 'a',
      rating: 5,
      body: 'b',
      author: { handle, avatarUrl: '', createdAt: '2020-01-01' },
      url,
      createdAt: '2020-01-01',
      thumbsUp: 0,
    });
    act(() => {
      useReviewsStore.setState({
        loading: false,
        error: null,
        byPid: new Map([
          [
            'a',
            {
              pluginId: 'a',
              count: 2,
              avg: 5,
              reviews: [
                mk('alice', 'https://github.com/x/y/discussions/1'),
                mk('bob', 'https://github.com/x/y/discussions/2'),
              ],
            },
          ],
        ]),
      });
    });
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => expect(container.textContent).toContain('A'));
    fireEvent.click(
      container.querySelector('button[aria-expanded]') as HTMLButtonElement,
    );
    const labels = Array.from(container.querySelectorAll('a'))
      .map((a) => a.getAttribute('aria-label') ?? '')
      .filter(Boolean);
    expect(labels.some((l) => l.includes('alice'))).toBe(true);
    expect(labels.some((l) => l.includes('bob'))).toBe(true);
  });

  // a11y(A39,A38 同族):thumbs-up 👍+数字仅视觉,须给 AT 视觉隐藏的本地化文本,emoji aria-hidden。
  it('a11y · review thumbs-up 有 AT 文本 + 👍 aria-hidden', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]);
    getMgr.mockReturnValue({ listAll: () => [] });
    act(() => {
      useReviewsStore.setState({
        loading: false,
        error: null,
        byPid: new Map([
          [
            'a',
            {
              pluginId: 'a',
              count: 1,
              avg: 5,
              reviews: [
                {
                  pluginId: 'a',
                  rating: 5,
                  body: 'great',
                  author: { handle: 'u', avatarUrl: '', createdAt: '2020-01-01' },
                  url: 'https://x',
                  createdAt: '2020-01-01',
                  thumbsUp: 3,
                },
              ],
            },
          ],
        ]),
      });
    });
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => expect(container.textContent).toContain('A'));
    fireEvent.click(
      container.querySelector('button[aria-expanded]') as HTMLButtonElement,
    );
    // 👍 在 aria-hidden 的内层 span(对 AT 隐藏)
    const emojiSpan = Array.from(
      container.querySelectorAll('span[aria-hidden="true"]'),
    ).find((s) => (s.textContent ?? '').includes('👍'));
    expect(emojiSpan).toBeDefined();
    // sr-only 本地化文本(视觉隐藏,position:absolute)含计数,对 AT 可读
    const srOnly = Array.from(container.querySelectorAll('span')).find(
      (s) =>
        s.style.position === 'absolute' && (s.textContent ?? '').includes('3'),
    );
    expect(srOnly).toBeDefined();
  });

  // a11y(A16,A8 同族):展开后排序按钮组(Newest/Helpful)须 aria-pressed 暴露当前排序。
  it('a11y · reviews 排序按钮组有 aria-pressed(单选)随点击切换', async () => {
    installApi(vi.fn());
    fetchIndexMock.mockResolvedValue([entry({ id: 'a', name: 'A' })]); // 无 tags → 无 tag toggle 干扰
    getMgr.mockReturnValue({ listAll: () => [] });
    act(() => {
      useReviewsStore.setState({
        loading: false,
        error: null,
        byPid: new Map([
          [
            'a',
            {
              pluginId: 'a',
              count: 1,
              avg: 5,
              reviews: [
                {
                  pluginId: 'a',
                  rating: 5,
                  body: 'great',
                  author: { handle: 'u', avatarUrl: '', createdAt: '2020-01-01' },
                  url: 'https://x',
                  createdAt: '2020-01-01',
                  thumbsUp: 0,
                },
              ],
            },
          ],
        ]),
      });
    });
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => expect(container.textContent).toContain('A'));
    fireEvent.click(
      container.querySelector('button[aria-expanded]') as HTMLButtonElement,
    );
    // 展开后:无 tag 时,带 aria-pressed 的就是 2 个排序按钮,恰一个 true(默认 newest)。
    const sortBtns = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'),
    );
    expect(sortBtns.length).toBe(2);
    const pressed = sortBtns.filter(
      (b) => b.getAttribute('aria-pressed') === 'true',
    );
    expect(pressed.length).toBe(1);
    // 点未选中的那个 → 它变 pressed
    const other = sortBtns.find(
      (b) => b.getAttribute('aria-pressed') === 'false',
    )!;
    fireEvent.click(other);
    expect(other.getAttribute('aria-pressed')).toBe('true');
    // a11y(A97):排序组有 role=group + aria-labelledby 指向含 sort 标签的元素。
    const group = container.querySelector('[role=group][aria-labelledby]');
    expect(group).not.toBeNull();
    const labelId = group!.getAttribute('aria-labelledby')!;
    const label = container.querySelector(`[id="${labelId}"]`);
    expect(label).not.toBeNull();
    expect((label!.textContent ?? '').length).toBeGreaterThan(0);
    // 两个排序按钮在该 group 内
    expect(group!.querySelectorAll('button[aria-pressed]').length).toBe(2);
  });
});

describe('MarketplaceTab — Git URL 安装段', () => {
  it('安装空 URL → 按钮 disabled', async () => {
    fetchIndexMock.mockResolvedValue([entry({ id: 'a' })]);
    installApi(vi.fn());
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('从 Git URL 安装');
    });
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '安装扩展')!;
    expect(btn.disabled).toBe(true);
  });

  it('Git URL 安装成功 → 「✔ 已安装 …」+ url 清空', async () => {
    const installFromGit = vi.fn().mockResolvedValue({
      ok: true,
      data: { id: 'p', name: 'P', version: '0.1.0' },
    });
    installApi(installFromGit);
    fetchIndexMock.mockResolvedValue([entry({ id: 'a' })]);
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('从 Git URL 安装');
    });
    const input = container.querySelector(
      'input[placeholder^="https"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'https://github.com/x/p.git' },
    });
    fireEvent.click(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent === '安装扩展')!,
    );
    await waitFor(() => {
      expect(installFromGit).toHaveBeenCalledWith(
        'https://github.com/x/p.git',
      );
      expect(container.textContent).toContain('已安装 P v0.1.0');
    });
    expect(input.value).toBe('');
    // a11y(A43):安装成功结果须 live region(成功=role=status/polite)主动播报。
    const statuses = Array.from(container.querySelectorAll('[role=status]'));
    expect(
      statuses.some((s) => (s.textContent ?? '').includes('已安装 P')),
    ).toBe(true);
  });

  it('Git URL 安装失败 ok=false → 「[code] message」(catalog 已去 ✘)', async () => {
    const installFromGit = vi.fn().mockResolvedValue({
      ok: false,
      code: 'X',
      message: 'oops',
    });
    installApi(installFromGit);
    fetchIndexMock.mockResolvedValue([entry({ id: 'a' })]);
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('从 Git URL 安装');
    });
    const input = container.querySelector(
      'input[placeholder^="https"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://x' } });
    fireEvent.click(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent === '安装扩展')!,
    );
    await waitFor(() => {
      expect(container.textContent).toContain('oops');
    });
    // a11y(A43):安装失败结果须 live region(失败=role=alert/assertive)主动播报。
    // 页面可能另有 alert(reviews 刷新失败),故定位含安装错误文本的那个。
    const alerts = Array.from(container.querySelectorAll('[role=alert]'));
    expect(alerts.some((a) => (a.textContent ?? '').includes('oops'))).toBe(
      true,
    );
  });

  // a11y(A85):Git URL 安装 catch 路径同样不拼 ✘。
  it('Git URL 安装抛 → message 含 err 且不含装饰 ✘', async () => {
    const installFromGit = vi.fn().mockRejectedValue(new Error('disk full'));
    installApi(installFromGit);
    fetchIndexMock.mockResolvedValue([entry({ id: 'a' })]);
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('从 Git URL 安装');
    });
    const input = container.querySelector(
      'input[placeholder^="https"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://x' } });
    fireEvent.click(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent === '安装扩展')!,
    );
    await waitFor(() => {
      expect(container.textContent).toContain('disk full');
    });
    const alert = Array.from(container.querySelectorAll('[role=alert]')).find((a) =>
      (a.textContent ?? '').includes('disk full'),
    );
    expect(alert).toBeTruthy();
    expect(alert!.textContent).not.toContain('✘');
  });
});
