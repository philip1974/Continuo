// @vitest-environment jsdom
// 打磨 R41(codex 性能):RatingRow 的 sorted = sortReviews(...).slice(0,10) 改为仅在
// 卡片展开时计算(expanded && hasReviews ? ... : [])。本测试守护「展开后排序 review
// 仍正确渲染」—— 若 gating 错误地恒返 [],展开也不显示 review,故能作为 neutralize。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../../marketplace/fetcher', () => ({
  fetchMarketplaceIndex: vi.fn(),
  fetchPluginManifest: vi.fn().mockResolvedValue({ id: '_', name: '_', version: '0.0.0' }),
}));
vi.mock('../../plugins/PluginManager', () => ({
  getUserPluginManager: vi.fn(() => null),
  setUserPluginManager: vi.fn(),
}));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { MarketplaceTab } from '../../marketplace/MarketplaceTab';
import { fetchMarketplaceIndex } from '../../marketplace/fetcher';
import { useUpdateStore } from '../../marketplace/update-store';
import { useReviewsStore } from '../../marketplace/reviews-store';
import { t } from '../../i18n';
import type { MarketplaceEntry } from '../../marketplace/types';
import type { PluginAggregateRating, Review } from '../../marketplace/reviews-types';

const fetchIndexMock = fetchMarketplaceIndex as unknown as ReturnType<typeof vi.fn>;

function entry(): MarketplaceEntry {
  return {
    id: 'com.x', name: 'X', description: 'd', author: 'me',
    repo: 'me/x', branch: 'main', tags: [], verified: false,
  };
}

function review(body: string): Review {
  return {
    pluginId: 'com.x', rating: 5, body,
    author: { handle: 'u', avatarUrl: '', createdAt: '2020-01-01T00:00:00Z' },
    url: `https://x/${body}`, createdAt: '2024-01-01T00:00:00Z', thumbsUp: 0,
  };
}

function rating(): PluginAggregateRating {
  return { pluginId: 'com.x', count: 1, avg: 5, reviews: [review('Great plugin here')] };
}

function installApi(): void {
  Object.defineProperty(window, 'api', {
    value: { plugins: { installFromGit: vi.fn() } }, writable: true, configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  fetchIndexMock.mockReset();
  useUpdateStore.setState({ available: [], remoteVersions: new Map(), checking: false, lastCheckedAt: null });
  useReviewsStore.setState({
    byPid: new Map([['com.x', rating()]]),
    loading: false, error: null, lastFetchedAt: null,
  });
});
afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
});

describe('打磨 R41 — review 仅在展开时排序渲染', () => {
  it('折叠时不显 review;展开后排序 review 正确渲染', async () => {
    fetchIndexMock.mockResolvedValue([entry()]);
    installApi();
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('X');
    });
    // 折叠态:review body 不在 DOM
    expect(container.textContent).not.toContain('Great plugin here');

    // 点展开按钮(title = 展开文案)
    const expandBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.title === t('marketplace.reviews.expand'));
    expect(expandBtn).toBeDefined();
    fireEvent.click(expandBtn!);

    // 展开后排序 review 渲染出来(gating 错误恒返 [] 则这里失败)
    expect(container.textContent).toContain('Great plugin here');
  });
});
