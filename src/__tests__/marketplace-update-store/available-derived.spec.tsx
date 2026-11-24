// @vitest-environment jsdom
//
// 可用更新是派生值:「已安装插件列表 × 远端版本表 × dismissed」现算,不存成状态。
//
// 旧实现把 available 存进 update-store,只靠本窗口两处手工同步(设置页卸载后 dismiss、市场页更新后对账)。
// 别的窗口卸载 / 更新插件时,本窗口经 PluginManager.handleUninstalled / 文件监视 reload 改了插件列表,
// 却不碰 update-store → 设置齿轮角标仍计入已卸载 / 已更新的插件,市场卡片仍显示「更新到 vX」。
// 卸载路径还把目标版本永久记进 dismissed,之后本会话重装旧版本再也看不到这条更新。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';

const { getMgr } = vi.hoisted(() => ({ getMgr: vi.fn() }));
vi.mock('../../plugins/PluginManager', async () => {
  const { asSubscribableManager } = await import('../plugins-tab-content/fake-user-plugin-manager');
  return {
    getUserPluginManager: () => asSubscribableManager(getMgr()),
    setUserPluginManager: vi.fn(),
  };
});

vi.mock('../../marketplace/fetcher', () => ({
  fetchMarketplaceIndex: vi.fn(),
  fetchPluginManifest: vi.fn(),
}));

vi.mock('../../plugins/permissions/co-permission-store', () => ({
  getUserPermissionStore: vi.fn(() => null),
  setUserPermissionStore: vi.fn(),
}));

vi.mock('../../lib/toggle-settings-panel', () => ({
  toggleSettingsPanel: vi.fn(),
}));

import { notifyUserPluginListChanged } from '../plugins-tab-content/fake-user-plugin-manager';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { IconSidebar } from '../../shell/IconSidebar';
import { MarketplaceTab } from '../../marketplace/MarketplaceTab';
import { PluginsTabContent } from '../../plugins/settings/PluginsTabContent';
import { fetchMarketplaceIndex } from '../../marketplace/fetcher';
import { useUpdateStore } from '../../marketplace/update-store';
import { useReviewsStore } from '../../marketplace/reviews-store';
import type { MarketplaceEntry } from '../../marketplace/types';

const fetchIndex = fetchMarketplaceIndex as unknown as ReturnType<typeof vi.fn>;

interface Installed {
  id: string;
  manifest: { id: string; name: string; version: string };
}

/** 新建一份已安装实例(新 manifest 对象 —— 与真 PluginManager 一致:重装 / reload 换 manifest,其余变化不换)。 */
function plugin(id: string, version: string): Installed {
  return { id, manifest: { id, name: id, version } };
}

/** 可变的假已安装列表:改 `installed` 后调 notifyUserPluginListChanged 模拟 PluginManager 列表变化。 */
let installed: Installed[] = [];
const fakeMgr = {
  listAll: () => installed.map((p) => ({ id: p.id, manifest: p.manifest, status: 'disabled' })),
  uninstall: vi.fn(async (id: string) => {
    installed = installed.filter((p) => p.id !== id);
    notifyUserPluginListChanged();
  }),
  reload: vi.fn(async () => {}),
};

function setInstalled(next: Installed[]): void {
  act(() => {
    installed = next;
    notifyUserPluginListChanged();
  });
}

function entry(id: string): MarketplaceEntry {
  return {
    id,
    name: id,
    description: '',
    author: 'me',
    repo: `me/${id}`,
    branch: 'main',
    tags: [],
    verified: false,
  };
}

function badge(container: HTMLElement): Element | null {
  return container.querySelector('[aria-label$="个插件可更新"]');
}

beforeEach(() => {
  _resetLmApiForTest();
  Object.defineProperty(window, 'api', {
    value: { plugins: { installFromGit: vi.fn() } },
    writable: true,
    configurable: true,
  });
  captureLmApi();
  installed = [plugin('a', '1.0.0'), plugin('b', '1.0.0')];
  notifyUserPluginListChanged();
  getMgr.mockReturnValue(fakeMgr);
  fakeMgr.uninstall.mockClear();
  useUpdateStore.setState({
    remoteVersions: new Map([
      ['a', '2.0.0'],
      ['b', '2.0.0'],
    ]),
    dismissed: new Map(),
  });
  useReviewsStore.setState({ byPid: new Map(), loading: false, error: null, lastFetchedAt: 0 });
});

afterEach(() => {
  cleanup();
  delete (window as { api?: unknown }).api;
  vi.restoreAllMocks();
});

describe('可用更新随已安装插件列表现算', () => {
  it('别的窗口卸载插件(列表变化)→ 设置齿轮角标立即不再计入', () => {
    const { container } = render(<IconSidebar />);
    expect(badge(container)?.getAttribute('aria-label')).toBe('2 个插件可更新');

    setInstalled([installed[1]!]); // 另一窗口卸载 a:本窗口走 handleUninstalled

    expect(badge(container)?.getAttribute('aria-label')).toBe('1 个插件可更新');
  });

  it('别的窗口更新插件(文件监视 reload 推进版本)→ 角标立即不再计入', () => {
    const { container } = render(<IconSidebar />);

    setInstalled([plugin('a', '2.0.0'), plugin('b', '2.0.0')]);

    expect(badge(container)).toBeNull();
  });

  it('别的窗口更新插件 → 市场卡片立即不再显示「更新到 vX」', async () => {
    fetchIndex.mockResolvedValue([entry('a')]);
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => {
      expect(container.textContent).toContain('更新到 v2.0.0');
    });

    setInstalled([plugin('a', '2.0.0'), installed[1]!]);

    expect(container.textContent).not.toContain('更新到 v2.0.0');
  });

  it('设置页卸载后重装旧版本 → 仍显示这条更新(卸载不写 dismissed)', async () => {
    const view = render(
      <>
        <IconSidebar />
        <PluginsTabContent />
      </>,
    );
    const uninstallButtons = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((b) => b.textContent === '卸载');
    fireEvent.click(uninstallButtons[0]!);
    fireEvent.click(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
      ).find((b) => b.textContent === '卸载')!,
    );
    await waitFor(() => {
      expect(fakeMgr.uninstall).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(badge(view.container)?.getAttribute('aria-label')).toBe('1 个插件可更新');
    });
    expect(useUpdateStore.getState().dismissed.size).toBe(0);

    // 重装旧版本(1.0.0 < 远端 2.0.0)→ 更新重新出现
    setInstalled([plugin('a', '1.0.0'), ...installed]);
    expect(badge(view.container)?.getAttribute('aria-label')).toBe('2 个插件可更新');
  });

  it('更新成功后的乐观 dismiss 只压制当前这份已安装实例:reload 失败仍收起,重装旧版本后重新显示', () => {
    const { container } = render(<IconSidebar />);

    act(() => {
      useUpdateStore.getState().dismiss('a');
    });
    expect(badge(container)?.getAttribute('aria-label')).toBe('1 个插件可更新');

    // 无关插件变化(b 更新;a 仍是同一份实例,如 reload 失败)→ a 仍被压制
    const a = installed[0]!;
    setInstalled([a, plugin('b', '2.0.0')]);
    expect(badge(container)).toBeNull();

    // 重装旧版本 a@1.0.0(新实例)→ 压制随旧实例失效,更新重新出现
    setInstalled([plugin('a', '1.0.0'), installed[1]!]);
    expect(badge(container)?.getAttribute('aria-label')).toBe('1 个插件可更新');
  });
});
