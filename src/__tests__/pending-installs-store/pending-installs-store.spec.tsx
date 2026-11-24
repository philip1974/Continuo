// @vitest-environment jsdom
// 「已安装、待重启」记录跨入口 / 跨页共享(见 README)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, waitFor, act } from '@testing-library/react';

vi.mock('../../marketplace/fetcher', () => ({
  fetchMarketplaceIndex: vi.fn(),
  fetchPluginManifest: vi.fn().mockResolvedValue({ id: '_', name: '_', version: '0.0.0' }),
}));

const { getMgr } = vi.hoisted(() => ({ getMgr: vi.fn() }));
vi.mock('../../plugins/PluginManager', async () => {
  const { asSubscribableManager } = await import('../plugins-tab-content/fake-user-plugin-manager');
  return {
    getUserPluginManager: () => asSubscribableManager(getMgr()),
    setUserPluginManager: vi.fn(),
  };
});

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { notifyUserPluginListChanged } from '../plugins-tab-content/fake-user-plugin-manager';
import { MarketplaceTab } from '../../marketplace/MarketplaceTab';
import { PluginsTabContent } from '../../plugins/settings/PluginsTabContent';
import { fetchMarketplaceIndex } from '../../marketplace/fetcher';
import { useUpdateStore } from '../../marketplace/update-store';
import { useReviewsStore } from '../../marketplace/reviews-store';
import {
  _resetPendingInstallsForTest,
  usePendingInstalls,
} from '../../plugins/pending-installs-store';
import type { PluginListItem } from '../../plugins/PluginManager';
import type { MarketplaceEntry } from '../../marketplace/types';

const fetchIndexMock = fetchMarketplaceIndex as unknown as ReturnType<typeof vi.fn>;

const ENTRY: MarketplaceEntry = {
  id: 'p.shared',
  name: 'Shared',
  description: 'd',
  author: 'me',
  repo: 'me/shared',
  branch: 'main',
  tags: [],
  verified: false,
};
const INSTALLED = { ok: true, data: { id: 'p.shared', name: 'Shared', version: '1.0.0' } };

function plugin(id: string, version = '0.1.0'): PluginListItem {
  return {
    id,
    manifest: { id, name: id, version } as never,
    status: 'disabled',
  } as PluginListItem;
}

let list: PluginListItem[] = [];
function setList(next: PluginListItem[]): void {
  list = next;
  notifyUserPluginListChanged();
}

function installApi(installFromGit: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'api', {
    value: { plugins: { installFromGit } },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

function button(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent === text,
  );
}

async function renderMarket() {
  const view = render(<MarketplaceTab />);
  await waitFor(() => expect(view.container.textContent).toContain('Shared'));
  return view;
}

async function installViaSettings(): Promise<void> {
  const { container, unmount } = render(<PluginsTabContent />);
  const input = container.querySelector('input') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'https://github.com/me/shared.git' } });
  fireEvent.click(button(container, '安装')!);
  await waitFor(() => expect(container.textContent).toContain('已安装 Shared v1.0.0'));
  unmount();
}

async function installViaCard(): Promise<void> {
  const { container, unmount } = await renderMarket();
  fireEvent.click(button(container, '安装')!);
  await waitFor(() => expect(container.textContent).toContain('已安装（待重启）'));
  unmount();
}

beforeEach(() => {
  _resetLmApiForTest();
  _resetPendingInstallsForTest();
  list = [];
  getMgr.mockReset();
  getMgr.mockReturnValue({
    listAll: () => list,
    uninstall: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
  });
  fetchIndexMock.mockReset();
  fetchIndexMock.mockResolvedValue([ENTRY]);
  useUpdateStore.setState({ remoteVersions: new Map(), dismissed: new Map(), refresh: async () => {} });
  useReviewsStore.setState({ byPid: new Map(), loading: false, error: null, lastFetchedAt: Date.now() });
  installApi(vi.fn().mockResolvedValue(INSTALLED));
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
});

describe('待重启记录跨入口 / 跨页共享', () => {
  it('设置页 Git 安装后切到别页再回来 → 待重启行仍在', async () => {
    await installViaSettings();
    const { container } = render(<PluginsTabContent />);
    expect(container.textContent).toContain('p.shared');
    expect(container.textContent).toContain('需重启 Continuo 才能加载');
  });

  it('市场卡片安装后切页再回来 → 卡片显示「已安装（待重启）」,不再给「安装」', async () => {
    await installViaCard();
    const { container } = await renderMarket();
    expect(container.textContent).toContain('已安装（待重启）');
    expect(button(container, '安装')).toBeUndefined();
  });

  it('市场底部「从 Git URL 安装」装了市场里也有的插件 → 卡片显示待重启', async () => {
    const { container } = await renderMarket();
    const input = container.querySelector('input[placeholder^="https"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://github.com/me/shared.git' } });
    fireEvent.click(button(container, '安装扩展')!);
    await waitFor(() => expect(container.textContent).toContain('已安装（待重启）'));
    expect(button(container, '安装')).toBeUndefined();
  });

  it('设置页装的插件 → 市场卡片显示待重启', async () => {
    await installViaSettings();
    const { container } = await renderMarket();
    expect(container.textContent).toContain('已安装（待重启）');
    expect(button(container, '安装')).toBeUndefined();
  });

  it('市场装的插件 → 设置页显示待重启行', async () => {
    await installViaCard();
    const { container } = render(<PluginsTabContent />);
    expect(container.textContent).toContain('p.shared');
    expect(container.textContent).toContain('需重启 Continuo 才能加载');
  });

  it('落地(进插件列表)即摘除,无需任何页面挂载;随后卸载 → 两页都无幽灵', async () => {
    await installViaCard();
    act(() => setList([plugin('p.shared', '1.0.0')]));
    expect(usePendingInstalls.getState().byId.size).toBe(0);
    act(() => setList([]));
    const market = await renderMarket();
    expect(button(market.container, '安装')).toBeDefined();
    market.unmount();
    const settings = render(<PluginsTabContent />);
    expect(settings.container.textContent).not.toContain('p.shared');
  });

  it('覆盖重装 / 更新已在列表的插件不记待重启 → 之后卸载卡片回到「安装」', async () => {
    list = [plugin('p.shared', '0.1.0')];
    useUpdateStore.setState({ remoteVersions: new Map([['p.shared', '1.0.0']]) });
    const first = await renderMarket();
    fireEvent.click(button(first.container, '更新到 v1.0.0')!);
    await waitFor(() => expect(first.container.textContent).toContain('Shared'));
    await waitFor(() => expect(usePendingInstalls.getState().byId.size).toBe(0));
    first.unmount();
    setList([]);
    const { container } = await renderMarket();
    expect(button(container, '安装')).toBeDefined();
  });

  it('记录时插件尚未被 manager 看到、之后在设置页卸载 → 同步清除记录,不留幽灵行', async () => {
    getMgr.mockReturnValue(null);
    await installViaCard();
    // manager 就绪且已列出该插件(记录未被摘除的极端时序),用户在设置页卸载。
    list = [plugin('p.shared', '1.0.0')];
    const uninstall = vi.fn().mockImplementation(async () => setList([]));
    getMgr.mockReturnValue({ listAll: () => list, uninstall });
    const { container } = render(<PluginsTabContent />);
    fireEvent.click(button(container, '卸载')!);
    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '卸载')!;
    fireEvent.click(confirm);
    await waitFor(() => expect(uninstall).toHaveBeenCalledWith('p.shared'));
    await waitFor(() => expect(usePendingInstalls.getState().byId.size).toBe(0));
    // 不留幽灵行(「已卸载 p.shared」成功播报里含 id,故按行内 id 徽标判断)。
    expect(Array.from(container.querySelectorAll('code')).some((c) => c.textContent === 'p.shared')).toBe(false);
    expect(container.textContent).not.toContain('需重启 Continuo 才能加载');
  });
});

// 别的窗口卸载了本窗口记为「待重启」的插件:本窗口列表里没有它,列表订阅不会触发摘除 —— 卸载广播须直接清记录,
// 否则市场卡片 / 设置页留下幽灵待重启行。
describe('跨窗口卸载广播清除待重启记录', () => {
  it('wirePluginEvents 收到 onUninstalled(id) → 清掉该 id 的记录', async () => {
    const { wirePluginEvents } = await import('../../plugins/plugin-events');
    const { recordPendingInstall, usePendingInstalls } = await import('../../plugins/pending-installs-store');
    recordPendingInstall({ id: 'com.x.ghost', name: 'G', version: '1.0.0' });
    expect(usePendingInstalls.getState().byId.has('com.x.ghost')).toBe(true);
    let uninstalled!: (id: string) => void;
    wirePluginEvents(
      {
        reload: vi.fn(async () => {}),
        handleUninstalled: vi.fn(async () => {}),
        handleEnabledChanged: vi.fn(async () => {}),
      } as never,
      {
        onChanged: () => {},
        onUninstalled: (cb) => {
          uninstalled = cb;
        },
        onEnabledChanged: () => {},
      },
      () => {},
    );
    uninstalled('com.x.ghost');
    expect(usePendingInstalls.getState().byId.has('com.x.ghost')).toBe(false);
  });
});

