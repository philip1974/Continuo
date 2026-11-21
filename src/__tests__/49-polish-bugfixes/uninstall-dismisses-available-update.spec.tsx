// @vitest-environment jsdom
//
// P2 UI 陈旧态回归(第八 session R1):在设置页「插件」Tab 卸载一个**此前有可用更新**的
// 插件后,IconSidebar 设置齿轮的「待更新」角标(=useUpdateStore.available.length)仍把这个
// 已不存在的插件计入,整个 session 不收敛。
//
// 根因:update-store.available 只在两处变更——启动时一次 refresh(main-app.ts) + marketplace
// 更新成功后的对账 refresh/dismiss(MarketplaceTab.onUpdate)。它**不订阅插件列表变化**,也无
// 周期性 refresh。而 PluginsTabContent.onConfirmUninstall(平行的卸载入口)成功后只调本地
// refresh()(useUserPlugins 列表),从不触碰 update-store → available 残留幻影条目。
//
// 属本仓最高频缺陷族「dismiss/防御建在一入口(MarketplaceTab),漏了功能对等的平行入口
// (设置页卸载)」+「派生标记离开状态漏清 = UI 陈旧态」。
//
// 修复:onConfirmUninstall 成功分支补 useUpdateStore.getState().dismiss(target.id),与
// MarketplaceTab.onUpdate 的乐观 dismiss 对称;失败时不 dismiss(插件仍在,仍可更新)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../plugins/PluginManager', () => ({
  getUserPluginManager: vi.fn(),
  setUserPluginManager: vi.fn(),
}));

vi.mock('../../plugins/permissions/co-permission-store', () => ({
  getUserPermissionStore: vi.fn(),
  setUserPermissionStore: vi.fn(),
}));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { PluginsTabContent } from '../../plugins/settings/PluginsTabContent';
import { getUserPluginManager } from '../../plugins/PluginManager';
import { getUserPermissionStore } from '../../plugins/permissions/co-permission-store';
import { useUpdateStore } from '../../marketplace/update-store';
import type { AvailableUpdate } from '../../marketplace/update-store';
import type { MarketplaceEntry } from '../../marketplace/types';
import type { PluginListItem } from '../../plugins/PluginManager';

const getMgr = getUserPluginManager as unknown as ReturnType<typeof vi.fn>;
const getPerm = getUserPermissionStore as unknown as ReturnType<typeof vi.fn>;

function plugin(id: string): PluginListItem {
  return {
    id,
    manifest: { id, name: id, version: '1.0.0' } as never,
    status: 'disabled',
  } as PluginListItem;
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
    verified: true,
  };
}

function avail(id: string): AvailableUpdate {
  return { id, name: id, from: '1.0.0', to: '2.0.0', entry: entry(id) };
}

function installPluginsApi(): void {
  Object.defineProperty(window, 'api', {
    value: { plugins: { installFromGit: vi.fn() } },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

function clickUninstallAndConfirm(container: HTMLElement): void {
  fireEvent.click(
    Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '卸载')!,
  );
  fireEvent.click(
    Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '卸载')!,
  );
}

beforeEach(() => {
  _resetLmApiForTest();
  getMgr.mockReturnValue(null);
  getPerm.mockReturnValue(null);
  useUpdateStore.setState({
    remoteVersions: new Map(),
    available: [avail('p.del'), avail('p.keep')],
    checking: false,
    lastCheckedAt: null,
  });
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('49 第八 session · 卸载插件后从 update-store.available 摘除', () => {
  it('卸载成功 → 该 id 从 available 摘除,角标计数收敛', async () => {
    installPluginsApi();
    const uninstall = vi.fn().mockResolvedValue(undefined);
    getMgr.mockReturnValue({ listAll: () => [plugin('p.del')], uninstall });
    const { container } = render(<PluginsTabContent />);

    // 卸载前:available 含 p.del(角标会把它计入)
    expect(
      useUpdateStore.getState().available.some((u) => u.id === 'p.del'),
    ).toBe(true);

    clickUninstallAndConfirm(container);

    await waitFor(() => {
      expect(uninstall).toHaveBeenCalledWith('p.del');
    });
    // 卸载成功后:p.del 已从 available 摘除,无幻影
    await waitFor(() => {
      expect(
        useUpdateStore.getState().available.some((u) => u.id === 'p.del'),
      ).toBe(false);
    });
    // 别的待更新插件不受影响
    expect(
      useUpdateStore.getState().available.some((u) => u.id === 'p.keep'),
    ).toBe(true);
  });

  it('卸载失败 → 不 dismiss(插件仍在,仍可更新)', async () => {
    installPluginsApi();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const uninstall = vi.fn().mockRejectedValue(new Error('busy'));
    getMgr.mockReturnValue({ listAll: () => [plugin('p.del')], uninstall });
    const { container } = render(<PluginsTabContent />);

    clickUninstallAndConfirm(container);

    await waitFor(() => {
      expect(container.textContent).toContain('卸载失败');
    });
    // 失败:p.del 仍留在 available(插件没被卸载,更新仍可用)
    expect(
      useUpdateStore.getState().available.some((u) => u.id === 'p.del'),
    ).toBe(true);
  });
});
