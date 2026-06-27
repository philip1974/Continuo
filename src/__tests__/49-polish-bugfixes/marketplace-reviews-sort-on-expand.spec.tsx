// @vitest-environment jsdom
// 打磨 R41(codex 性能):RatingRow 的 sorted = sortReviews(...).slice(0,10) 改为仅在
// 卡片展开时计算(expanded && hasReviews ? ... : [])。本测试守护「展开后排序 review
// 仍正确渲染」—— 若 gating 错误地恒返 [],展开也不显示 review,故能作为 neutralize。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../marketplace/fetcher', () => ({
  fetchMarketplaceIndex: vi.fn(),
  fetchPluginManifest: vi.fn().mockResolvedValue({ id: '_', name: '_', version: '0.0.0' }),
}));
vi.mock('../../plugins/PluginManager', () => ({
  getUserPluginManager: vi.fn(() => null),
  setUserPluginManager: vi.fn(),
}));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import {
  MarketplaceTab,
  selectDisplayReviews,
} from '../../marketplace/MarketplaceTab';
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

function review(body: string, thumbsUp = 0): Review {
  return {
    pluginId: 'com.x', rating: 5, body,
    author: { handle: 'u', avatarUrl: '', createdAt: '2020-01-01T00:00:00Z' },
    url: `https://x/${body}`, createdAt: '2024-01-01T00:00:00Z', thumbsUp,
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
  it('MarketplaceTab 空 entries/reviews fallback 使用稳定引用', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/marketplace/MarketplaceTab.tsx'),
      'utf-8',
    );

    expect(src).toContain('EMPTY_MARKETPLACE_ENTRIES');
    expect(src).not.toContain('stateEntries ?? []');
    expect(src).not.toContain('ratingReviews ?? []');
    expect(src).not.toContain(': []\n    [expanded, hasReviews, sourceReviews, sort]');
  });

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

  it('切到有用排序 → 只选择前 10 条,不全量 Array.sort', async () => {
    const reviews = Array.from({ length: 20 }, (_, i) =>
      review(`review-${String(i).padStart(2, '0')}`, i),
    );
    useReviewsStore.setState({
      byPid: new Map([
        ['com.x', { pluginId: 'com.x', count: 20, avg: 5, reviews }],
      ]),
      loading: false,
      error: null,
      lastFetchedAt: null,
    });
    fetchIndexMock.mockResolvedValue([entry()]);
    installApi();
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('X');
    });

    const expandBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.title === t('marketplace.reviews.expand'));
    expect(expandBtn).toBeDefined();
    fireEvent.click(expandBtn!);

    const helpfulBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === t('marketplace.reviews.sort_helpful'));
    expect(helpfulBtn).toBeDefined();
    const sortSpy = vi.spyOn(Array.prototype, 'sort');
    fireEvent.click(helpfulBtn!);
    const sortCalls = sortSpy.mock.calls.length;
    sortSpy.mockRestore();

    expect(sortCalls).toBe(0);
    expect(container.textContent).toContain('review-19');
    expect(container.textContent).toContain('review-10');
    expect(container.textContent).not.toContain('review-09');
  });

  it('有用排序维护短窗口时不通过 push/splice/pop 调整数组', () => {
    const reviews = Array.from({ length: 20 }, (_, i) =>
      review(`review-${String(i).padStart(2, '0')}`, i),
    );

    const visible = selectDisplayReviews(reviews, 'helpful', 10);

    expect(visible.map((r) => r.body)).toEqual([
      'review-19',
      'review-18',
      'review-17',
      'review-16',
      'review-15',
      'review-14',
      'review-13',
      'review-12',
      'review-11',
      'review-10',
    ]);
    expect(selectDisplayReviews.toString()).not.toContain('top.push(');
    expect(selectDisplayReviews.toString()).not.toContain('top.splice(');
    expect(selectDisplayReviews.toString()).not.toContain('top.pop(');
  });

  it('newest 排序只拷贝可见前 N 条,不通过 slice 分配中间数组', () => {
    const reviews = Array.from({ length: 20 }, (_, i) => review(`review-${i}`));
    const sliceSpy = vi.spyOn(Array.prototype, 'slice');

    try {
      const visible = selectDisplayReviews(reviews, 'newest', 10);

      expect(visible.map((r) => r.body)).toEqual([
        'review-0',
        'review-1',
        'review-2',
        'review-3',
        'review-4',
        'review-5',
        'review-6',
        'review-7',
        'review-8',
        'review-9',
      ]);
      expect(sliceSpy).not.toHaveBeenCalled();
      expect(selectDisplayReviews.toString()).not.toContain('visible.push(');
    } finally {
      sliceSpy.mockRestore();
    }
  });

  it('空 reviews / newest 未超过 limit → 复用稳定引用', () => {
    const reviews = [review('review-0'), review('review-1')];
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(selectDisplayReviews([], 'newest', 10)).toEqual([]);
      expect(selectDisplayReviews([], 'newest', 10)).toBe(
        selectDisplayReviews([], 'helpful', 10),
      );
      expect(selectDisplayReviews(reviews, 'newest', 10)).toBe(reviews);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('helpful 排序只有单条 review 时复用原数组引用', () => {
    const reviews = [review('only', 3)];

    expect(selectDisplayReviews(reviews, 'helpful', 10)).toBe(reviews);
  });

  it('helpful 排序已按有用顺序且未超过 limit 时复用原数组引用', () => {
    const reviews = [
      review('most-helpful', 10),
      review('middle-helpful', 5),
      review('least-helpful', 1),
    ];

    expect(selectDisplayReviews(reviews, 'helpful', 10)).toBe(reviews);
  });
});
