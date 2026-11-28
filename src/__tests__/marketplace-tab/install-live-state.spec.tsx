// @vitest-environment jsdom
// BDD: marketplace-tab —— 安装结果文案只写「已安装」,启用结果从 PluginManager 实时状态派生(见同目录 README)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('../../marketplace/fetcher', () => ({
  MARKETPLACE_NETWORK: 'MARKETPLACE_NETWORK',
  fetchMarketplaceIndex: vi.fn(),
  fetchPluginManifest: vi.fn().mockResolvedValue({ id: '_', name: '_', version: '0.0.0' }),
}));

const { state } = vi.hoisted(() => ({ state: { list: [] as unknown[] } }));
vi.mock('../../plugins/PluginManager', async () => {
  const { asSubscribableManager } = await import('../plugins-tab-content/fake-user-plugin-manager');
  const mgr = { listAll: () => state.list, adoptInstalled: async () => true };
  return { getUserPluginManager: () => asSubscribableManager(mgr), setUserPluginManager: vi.fn() };
});

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { notifyUserPluginListChanged } from '../plugins-tab-content/fake-user-plugin-manager';
import { MarketplaceTab } from '../../marketplace/MarketplaceTab';
import { fetchMarketplaceIndex } from '../../marketplace/fetcher';
import { useUpdateStore } from '../../marketplace/update-store';
import { _resetPendingInstallsForTest } from '../../plugins/pending-installs-store';

const fetchIndexMock = fetchMarketplaceIndex as unknown as ReturnType<typeof vi.fn>;

function installApi(installFromGit: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'api', {
    value: { plugins: { installFromGit } },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

const listItem = (id: string, status: string, error?: { code: string; message: string; params?: Record<string, string> }) => ({
  id,
  manifest: { id, name: id.toUpperCase(), version: '1.0.0' },
  status,
  ...(error ? { error } : {}),
});

function setList(list: unknown[]): void {
  act(() => {
    state.list = list;
    notifyUserPluginListChanged();
  });
}

beforeEach(() => {
  _resetLmApiForTest();
  _resetPendingInstallsForTest();
  state.list = [];
  notifyUserPluginListChanged();
  useUpdateStore.setState({ remoteVersions: new Map(), dismissed: new Map(), refresh: async () => {} });
  fetchIndexMock.mockReset();
  fetchIndexMock.mockResolvedValue([
    { id: 'a', name: 'A', description: 'd', author: 'me', repo: 'me/a', branch: 'main', tags: [], verified: false },
  ]);
});
afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
});

describe('市场卡片安装', () => {
  it('成功文案只写「已安装 A v1.0.0」;启用结果随插件实时状态显示(权限被拒 → 失败原因;启用 → 已启用)', async () => {
    installApi(vi.fn().mockResolvedValue({ ok: true, data: { id: 'a', name: 'A', version: '1.0.0' } }));
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => expect(container.textContent).toContain('A'));
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '安装')!);
    await waitFor(() => expect(container.textContent).toContain('已安装 A v1.0.0'));
    expect(container.textContent).not.toContain('已启用');

    setList([listItem('a', 'failed', { code: 'PERMISSION_DENIED', message: 'fs', params: { perms: 'fs' } })]);
    const alert = Array.from(container.querySelectorAll('[role=alert]')).find((n) =>
      (n.textContent ?? '').includes('所需权限已被拒绝：fs'),
    );
    expect(alert).toBeTruthy();
    expect(container.textContent).not.toContain('已启用');

    setList([listItem('a', 'enabled')]);
    expect(container.textContent).toContain('已启用');
    expect(container.textContent).not.toContain('所需权限已被拒绝');

    setList([listItem('a', 'disabled')]);
    expect(container.textContent).toContain('已禁用');
  });
});

describe('Git URL 段安装', () => {
  it('成功文案只写「已安装 P v0.1.0」,随后显示所装插件的实时状态', async () => {
    installApi(vi.fn().mockResolvedValue({ ok: true, data: { id: 'p', name: 'P', version: '0.1.0' } }));
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => expect(container.textContent).toContain('从 Git URL 安装'));
    const input = container.querySelector('input[placeholder^="https"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://github.com/x/p.git' } });
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '安装插件')!);
    await waitFor(() => expect(container.textContent).toContain('已安装 P v0.1.0'));
    expect(container.textContent).not.toContain('已启用');
    setList([listItem('p', 'failed', { code: 'EXCEPTION', message: 'kaput' })]);
    expect(container.textContent).toContain('激活失败：kaput');
    setList([listItem('p', 'enabled')]);
    expect(container.textContent).toContain('已启用');
  });
});
