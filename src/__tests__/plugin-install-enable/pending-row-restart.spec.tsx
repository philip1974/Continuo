// @vitest-environment jsdom
// 安装后:发起热激活(adoptInstalled);热激活未落地时待重启行有「立即重启」→ coApi.window.relaunchApp。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

const { getMgr } = vi.hoisted(() => ({ getMgr: vi.fn() }));
vi.mock('../../plugins/PluginManager', async () => {
  const { asSubscribableManager } = await import('../plugins-tab-content/fake-user-plugin-manager');
  return {
    getUserPluginManager: () => asSubscribableManager(getMgr()),
    setUserPluginManager: vi.fn(),
  };
});
vi.mock('../../plugins/permissions/co-permission-store', () => ({
  getUserPermissionStore: vi.fn(() => null),
  setUserPermissionStore: vi.fn(),
}));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { PluginsTabContent } from '../../plugins/settings/PluginsTabContent';
import { _resetPendingInstallsForTest, recordPendingInstall } from '../../plugins/pending-installs-store';

const relaunchApp = vi.fn().mockResolvedValue({ ok: true, data: undefined });
const adoptInstalled = vi.fn().mockResolvedValue(false);

beforeEach(() => {
  _resetLmApiForTest();
  _resetPendingInstallsForTest();
  relaunchApp.mockClear();
  adoptInstalled.mockClear();
  getMgr.mockReturnValue({ listAll: () => [], adoptInstalled });
  Object.defineProperty(window, 'api', {
    value: {
      plugins: {
        installFromGit: vi.fn().mockResolvedValue({ ok: true, data: { id: 'p.new', name: 'New', version: '1.0.0' } }),
      },
      window: { relaunchApp },
    },
    writable: true,
    configurable: true,
  });
  captureLmApi();
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
});

describe('安装后热激活 + 立即重启', () => {
  it('recordPendingInstall(全新安装)→ 发起 manager.adoptInstalled(id)', async () => {
    expect(recordPendingInstall({ id: 'p.new', name: 'New', version: '1.0.0' })).toBe(true);
    await waitFor(() => expect(adoptInstalled).toHaveBeenCalledWith('p.new'));
  });

  it('Git 安装成功:文案「已安装 …」(启用与否看插件行实时状态),待重启行有「立即重启」,点击走 relaunchApp', async () => {
    const { container } = render(<PluginsTabContent />);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://github.com/me/new.git' } });
    fireEvent.click(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '安装')!);
    await waitFor(() => expect(container.textContent).toContain('已安装 New v1.0.0'));

    const restart = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === '立即重启',
    );
    expect(restart).toBeDefined();
    fireEvent.click(restart!);
    expect(relaunchApp).toHaveBeenCalledTimes(1);
  });
});
