// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act, waitFor } from '@testing-library/react';

vi.mock('../../marketplace/fetcher', () => ({
  fetchMarketplaceIndex: vi.fn(),
  fetchPluginManifest: vi.fn().mockResolvedValue({
    id: '_',
    name: '_',
    version: '0.0.0',
  }),
}));

vi.mock('../../plugins/co-plugin-manager', () => ({
  getUserPluginManager: vi.fn(),
  setUserPluginManager: vi.fn(),
}));

import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { MarketplaceTab } from '../../marketplace/MarketplaceTab';
import { fetchMarketplaceIndex } from '../../marketplace/fetcher';
import { getUserPluginManager } from '../../plugins/co-plugin-manager';
import { useUpdateStore } from '../../marketplace/update-store';
import { useReviewsStore } from '../../marketplace/reviews-store';
import type { MarketplaceEntry } from '../../marketplace/types';

const fetchIndexMock = fetchMarketplaceIndex as unknown as ReturnType<typeof vi.fn>;
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

  it('error → 「✘ 拉取索引失败」', async () => {
    fetchIndexMock.mockRejectedValue(new Error('offline'));
    installApi(vi.fn());
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('拉取索引失败');
      expect(container.textContent).toContain('offline');
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
    fireEvent.click(uiTagBtn);
    expect(container.textContent).toContain('A');
    expect(container.textContent).not.toContain('B');

    // 清除按钮出现
    const clearBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '清除筛选')!;
    fireEvent.click(clearBtn);
    expect(container.textContent).toContain('B');
  });
});

describe('MarketplaceTab — 安装按钮', () => {
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
  });

  it('install ok=false → 「✘ [code] message」', async () => {
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
  });

  it('install 抛 → 「✘ ${err.message}」', async () => {
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
  });
});

describe('MarketplaceTab — 更新按钮', () => {
  it('updateStore 中有 entry → 显「更新」按钮 → uninstall + installFromGit', async () => {
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
      expect(uninstall).toHaveBeenCalledWith('a');
      expect(installFromGit).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.textContent).toContain('更新到 A v2.0.0');
    });
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
  });

  it('Git URL 安装失败 ok=false → 「✘ [code] message」', async () => {
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
  });

  it('Git URL 安装抛 → 「✘ ${err}」', async () => {
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
  });
});
