// @vitest-environment jsdom
// 打磨 R35(codex 一致性/i18n):Marketplace verified 徽章原先硬编码 '✓ verified',
// title 却已走 i18n。补 marketplace.verified 到 en/zh/ko 后徽章可见文本也走 t(),
// zh/ko locale 下卡片不再混入英文。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

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
import { setLocale } from '../../i18n';
import type { MarketplaceEntry } from '../../marketplace/types';

const fetchIndexMock = fetchMarketplaceIndex as unknown as ReturnType<typeof vi.fn>;

function verifiedEntry(): MarketplaceEntry {
  return {
    id: 'com.x',
    name: 'X Plugin',
    description: 'd',
    author: 'me',
    repo: 'me/x',
    branch: 'main',
    tags: [],
    verified: true,
  };
}

function installApi(): void {
  Object.defineProperty(window, 'api', {
    value: { plugins: { installFromGit: vi.fn() } },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  fetchIndexMock.mockReset();
  useUpdateStore.setState({ available: [], remoteVersions: new Map(), checking: false, lastCheckedAt: null });
  useReviewsStore.setState({ byPid: new Map(), loading: false, error: null, lastFetchedAt: null });
});
afterEach(() => {
  delete (window as { api?: unknown }).api;
  setLocale('en');
  cleanup();
});

describe('打磨 R35 — Marketplace verified 徽章本地化', () => {
  it('zh locale → 徽章显「✓ 已验证」,不混英文 verified', async () => {
    setLocale('zh');
    fetchIndexMock.mockResolvedValue([verifiedEntry()]);
    installApi();
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('已验证');
    });
    expect(container.textContent).not.toContain('verified');
    // 打磨 R36:作者前缀也本地化(原硬编码 'by')
    expect(container.textContent).toContain('作者');
  });

  it('en locale → 徽章显「✓ verified」', async () => {
    setLocale('en');
    fetchIndexMock.mockResolvedValue([verifiedEntry()]);
    installApi();
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('verified');
    });
  });
});
