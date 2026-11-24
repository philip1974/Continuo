// @vitest-environment jsdom
// 操作后焦点不掉 body:设置项 / 快捷键重置、卸载插件、市场卡片安装。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';

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
vi.mock('../../plugins/permissions/co-permission-store', () => ({
  getUserPermissionStore: vi.fn(() => null),
  setUserPermissionStore: vi.fn(),
}));

import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { notifyUserPluginListChanged } from '../plugins-tab-content/fake-user-plugin-manager';
import { SettingItemRow } from '../../plugins/settings/SettingItemRow';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';
import { KeybindingsTabContent } from '../../plugins/settings/KeybindingsTabContent';
import { PluginsTabContent } from '../../plugins/settings/PluginsTabContent';
import { MarketplaceTab } from '../../marketplace/MarketplaceTab';
import { fetchMarketplaceIndex } from '../../marketplace/fetcher';
import { useUpdateStore } from '../../marketplace/update-store';
import { useReviewsStore } from '../../marketplace/reviews-store';
import { _resetPendingInstallsForTest } from '../../plugins/pending-installs-store';
import { coApp } from '../../plugins/co-app';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import type { PluginListItem } from '../../plugins/PluginManager';
import type { SettingItemSpec } from '../../plugins/registries/SettingItemRegistry';

beforeEach(() => {
  _resetLmApiForTest();
  _resetPendingInstallsForTest();
  getMgr.mockReset();
  useSettingsValuesStore.setState({ values: {} });
  useKeybindingsStore.setState({ overrides: {} });
  (coApp as { commands: CommandRegistry }).commands = new CommandRegistry();
});
afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
});

function resetButton(container: HTMLElement, label: RegExp): HTMLButtonElement {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    label.test(b.getAttribute('aria-label') ?? ''),
  )!;
}

describe('设置项「恢复默认」→ 焦点到同行编辑控件', () => {
  const cases: Array<[string, SettingItemSpec, unknown, (el: Element | null) => boolean]> = [
    [
      'boolean → 开关',
      { id: 't.bool', category: 'x', title: 'Bool', type: 'boolean', default: false } as SettingItemSpec,
      true,
      (el) => el?.getAttribute('role') === 'switch',
    ],
    [
      'number → 输入框',
      { id: 't.num', category: 'x', title: 'Num', type: 'number', default: 1, min: 0, max: 10 } as SettingItemSpec,
      5,
      (el) => (el as HTMLInputElement | null)?.type === 'number',
    ],
    [
      'select → 重置后选中的分段项',
      {
        id: 't.sel',
        category: 'x',
        title: 'Sel',
        type: 'select',
        default: 'a',
        enum: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ],
      } as SettingItemSpec,
      'b',
      (el) => el?.getAttribute('role') === 'radio' && el.textContent === 'Alpha',
    ],
  ];
  for (const [name, spec, value, isControl] of cases) {
    it(name, () => {
      useSettingsValuesStore.setState({ values: { [spec.id]: value as never } });
      const { container } = render(<SettingItemRow spec={spec} />);
      const reset = resetButton(container, /恢复默认/);
      reset.focus();
      fireEvent.click(reset);
      expect(useSettingsValuesStore.getState().values[spec.id]).toBeUndefined();
      expect(isControl(document.activeElement)).toBe(true);
    });
  }
});

describe('快捷键「恢复默认」→ 焦点到同行编辑按钮', () => {
  it('重置后焦点在该命令行的「编辑快捷键」按钮', () => {
    coApp.commands.register({ id: 'a', title: 'Alpha', hotkey: 'mod+a', fn: vi.fn() });
    coApp.commands.register({ id: 'b', title: 'Beta', hotkey: 'mod+b', fn: vi.fn() });
    useKeybindingsStore.setState({ overrides: { b: 'mod+x' } });
    const { container } = render(<KeybindingsTabContent />);
    const reset = resetButton(container, /将 Beta 的快捷键恢复默认/);
    reset.focus();
    fireEvent.click(reset);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('编辑 Beta 的快捷键');
  });

  it('该行被搜索过滤掉(按旧快捷键搜)→ 焦点回搜索框', () => {
    coApp.commands.register({ id: 'b', title: 'Beta', hotkey: 'mod+b', fn: vi.fn() });
    useKeybindingsStore.setState({ overrides: { b: 'mod+x' } });
    const { container } = render(<KeybindingsTabContent />);
    const search = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'ctrl+x' } });
    const reset = resetButton(container, /将 Beta 的快捷键恢复默认/);
    reset.focus();
    fireEvent.click(reset);
    expect(document.activeElement).toBe(search);
  });
});

function plugin(id: string): PluginListItem {
  return { id, manifest: { id, name: `Name ${id}`, version: '1.0.0' } as never, status: 'disabled' } as PluginListItem;
}

describe('卸载插件 → 焦点到相邻行 + 成功播报', () => {
  function setup(ids: string[]) {
    let list = ids.map(plugin);
    const uninstall = vi.fn(async (id: string) => {
      list = list.filter((p) => p.id !== id);
      notifyUserPluginListChanged();
    });
    getMgr.mockReturnValue({ listAll: () => list, uninstall });
    Object.defineProperty(window, 'api', { value: { plugins: {} }, writable: true, configurable: true });
    captureLmApi();
    return render(<PluginsTabContent />);
  }
  async function uninstallVia(container: HTMLElement, name: string): Promise<void> {
    const btn = resetButton(container, new RegExp(`卸载.*${name}`));
    btn.focus();
    fireEvent.click(btn);
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button')).find(
      (b) => b.textContent === '卸载',
    )!;
    await act(async () => {
      fireEvent.click(confirm);
    });
  }

  it('卸载中间一行 → 焦点到下一行的「卸载」+ role=status 播报「已卸载 …」', async () => {
    const { container } = setup(['a', 'b', 'c']);
    await uninstallVia(container, 'Name b');
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label') ?? '').toMatch(/卸载.*Name c/),
    );
    const statuses = Array.from(container.querySelectorAll('[role=status]')).map((s) => s.textContent);
    expect(statuses.some((s) => s?.includes('已卸载 Name b'))).toBe(true);
  });

  it('卸载最后一行 → 焦点到上一行的「卸载」', async () => {
    const { container } = setup(['a', 'b']);
    await uninstallVia(container, 'Name b');
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label') ?? '').toMatch(/卸载.*Name a/),
    );
  });

  it('卸载唯一一行 → 焦点到「用户插件」标题', async () => {
    const { container } = setup(['a']);
    await uninstallVia(container, 'Name a');
    await waitFor(() => expect(document.activeElement?.tagName).toBe('H3'));
    expect(document.activeElement?.textContent).toBe('用户插件');
  });
});

describe('市场卡片安装:aria-disabled 保持可聚焦,防重复触发', () => {
  it('安装中按钮 aria-disabled(非原生 disabled)、焦点不丢;重复点击不重复安装;装好后焦点仍在按钮上', async () => {
    (fetchMarketplaceIndex as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'm.p', name: 'MP', description: 'd', author: 'me', repo: 'me/mp', branch: 'main', tags: [], verified: false },
    ]);
    useUpdateStore.setState({ remoteVersions: new Map(), dismissed: new Map(), refresh: async () => {} });
    useReviewsStore.setState({ byPid: new Map(), loading: false, error: null, unavailable: false, lastFetchedAt: Date.now() });
    let resolveInstall!: (v: unknown) => void;
    const installFromGit = vi.fn(() => new Promise((r) => (resolveInstall = r)));
    getMgr.mockReturnValue({ listAll: () => [] });
    Object.defineProperty(window, 'api', { value: { plugins: { installFromGit } }, writable: true, configurable: true });
    captureLmApi();
    const { container } = render(<MarketplaceTab />);
    await waitFor(() => expect(container.textContent).toContain('MP'));
    const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === '安装',
    )!;
    btn.focus();
    fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute('aria-disabled')).toBe('true'));
    expect(btn.disabled).toBe(false);
    expect(document.activeElement).toBe(btn);
    fireEvent.click(btn);
    expect(installFromGit).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInstall({ ok: true, data: { id: 'm.p', name: 'MP', version: '1.0.0' } });
    });
    await waitFor(() => expect(btn.textContent).toContain('已安装'));
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(btn);
  });

  it('design Button:aria-disabled 与 :disabled 同一视觉(半透明 / 禁止光标),hover 不变色', () => {
    const css = readFileSync(join(process.cwd(), 'src/design/Button.css'), 'utf8');
    expect(css).toMatch(/\.wm-button:disabled,\s*\.wm-button\[aria-disabled="true"\]\s*\{[^}]*opacity:\s*0\.5/);
    for (const m of css.matchAll(/:hover:not\(([^)]*)\)/g)) {
      expect(m[0]).toContain('[aria-disabled="true"]');
    }
  });
});
