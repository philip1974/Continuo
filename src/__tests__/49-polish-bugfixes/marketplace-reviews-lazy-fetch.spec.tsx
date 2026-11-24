// @vitest-environment jsdom
// 打磨 R53(性能):Marketplace reviews(卡片 ★)不再启动预拉,改为 MarketplaceTab
// 首次挂载时拉(store lastFetchedAt 防重复)。未打开插件商店的 session 不再在冷启动
// 路径打 GitHub API。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const { fetchAllReviewsMock } = vi.hoisted(() => ({
  fetchAllReviewsMock: vi.fn(async () => new Map()),
}));
vi.mock('../../marketplace/reviews-fetcher', () => ({
  fetchAllReviews: fetchAllReviewsMock,
}));
vi.mock('../../marketplace/fetcher', () => ({
  fetchMarketplaceIndex: vi.fn(async () => []),
  fetchPluginManifest: vi.fn().mockResolvedValue({ id: '_', name: '_', version: '0.0.0' }),
}));
vi.mock('../../plugins/PluginManager', () => ({
  getUserPluginManager: vi.fn(() => null),
  setUserPluginManager: vi.fn(),
}));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { MarketplaceTab } from '../../marketplace/MarketplaceTab';
import { useReviewsStore } from '../../marketplace/reviews-store';
import { useUpdateStore } from '../../marketplace/update-store';

function installApi(): void {
  Object.defineProperty(window, 'api', {
    value: { plugins: { installFromGit: vi.fn() } }, writable: true, configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  fetchAllReviewsMock.mockClear();
  useUpdateStore.setState({ remoteVersions: new Map(), dismissed: new Map() });
  useReviewsStore.setState({ byPid: new Map(), loading: false, error: null, lastFetchedAt: null });
  installApi();
});
afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
});

describe('打磨 R53 — reviews 延迟到 MarketplaceTab 挂载', () => {
  it('首次挂载(lastFetchedAt=null)→ 拉 reviews', () => {
    render(<MarketplaceTab />);
    expect(fetchAllReviewsMock).toHaveBeenCalled();
  });

  it('已拉过(lastFetchedAt 非空)→ 挂载不重复拉', () => {
    useReviewsStore.setState({ lastFetchedAt: 12345 });
    render(<MarketplaceTab />);
    expect(fetchAllReviewsMock).not.toHaveBeenCalled();
  });
});

// 打开市场页即刷新可用更新:此前 update-store.refresh 只在启动时调一次,启动时离线则整个会话看不到更新按钮 / 角标。
describe('MarketplaceTab 挂载 → 刷新可用更新', () => {
  it('挂载时调用 update-store refresh', () => {
    const refresh = vi.spyOn(useUpdateStore.getState(), 'refresh').mockResolvedValue(undefined);
    render(<MarketplaceTab />);
    expect(refresh).toHaveBeenCalledTimes(1);
    refresh.mockRestore();
  });
});

