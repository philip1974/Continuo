// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act, waitFor } from '@testing-library/react';

vi.mock('../../plugins/PluginManager', () => ({
  getUserPluginManager: vi.fn(),
  setUserPluginManager: vi.fn(),
}));

vi.mock('../../plugins/permissions/co-permission-store', () => ({
  getUserPermissionStore: vi.fn(),
  setUserPermissionStore: vi.fn(),
}));

import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { PluginsTabContent } from '../../plugins/settings/PluginsTabContent';
import { coApp } from '../../plugins/co-app';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { PanelRegistry } from '../../plugins/registries/PanelRegistry';
import { StatusBarRegistry } from '../../plugins/registries/StatusBarRegistry';
import { RibbonRegistry } from '../../plugins/registries/RibbonRegistry';
import { SettingTabRegistry } from '../../plugins/registries/SettingTabRegistry';
import { EditorActionRegistry } from '../../plugins/registries/EditorActionRegistry';
import { ExplorerDecoratorRegistry } from '../../plugins/registries/ExplorerDecoratorRegistry';
import { getUserPluginManager } from '../../plugins/PluginManager';
import { getUserPermissionStore } from '../../plugins/permissions/co-permission-store';
import type { PluginListItem } from '../../plugins/PluginManager';

const getMgr = getUserPluginManager as unknown as ReturnType<typeof vi.fn>;
const getPerm = getUserPermissionStore as unknown as ReturnType<typeof vi.fn>;

interface FakeManager {
  listAll: () => readonly PluginListItem[];
  enable?: ReturnType<typeof vi.fn>;
  disable?: ReturnType<typeof vi.fn>;
  reload?: ReturnType<typeof vi.fn>;
  uninstall?: ReturnType<typeof vi.fn>;
}

function plugin(over: Partial<PluginListItem> & { id: string }): PluginListItem {
  const base: PluginListItem = {
    id: over.id,
    manifest: {
      id: over.id,
      name: over.id,
      version: '0.1.0',
      ...(over.manifest ?? {}),
    } as never,
    status: 'disabled',
  } as PluginListItem;
  return { ...base, ...over } as PluginListItem;
}

function installPluginsApi(installFromGit: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'api', {
    value: { plugins: { installFromGit } },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  // 隔离 registries
  (coApp as { panels: PanelRegistry }).panels = new PanelRegistry();
  (coApp as { commands: CommandRegistry }).commands = new CommandRegistry();
  (coApp as { statusBar: StatusBarRegistry }).statusBar = new StatusBarRegistry();
  (coApp as { ribbon: RibbonRegistry }).ribbon = new RibbonRegistry();
  (coApp as { settingTabs: SettingTabRegistry }).settingTabs = new SettingTabRegistry();
  (coApp as { editorActions: EditorActionRegistry }).editorActions = new EditorActionRegistry();
  (coApp as { explorerDecorators: ExplorerDecoratorRegistry }).explorerDecorators = new ExplorerDecoratorRegistry();
  getMgr.mockReturnValue(null);
  getPerm.mockReturnValue(null);
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.restoreAllMocks();
});

describe('PluginsTabContent — 贡献点统计', () => {
  it('空 registry → 7 行 count=0,samples=「—」', () => {
    const { container } = render(<PluginsTabContent />);
    expect(container.textContent).toContain('已注册贡献点');
    // 7 个 label
    for (const label of [
      'Panel 类型',
      '命令',
      'StatusBar 项',
      'Ribbon 图标',
      '设置 Tab',
      'Explorer 装饰器',
      'Editor Action',
    ]) {
      expect(container.textContent).toContain(label);
    }
  });

  it('注册命令 → count + samples 反映', () => {
    coApp.commands.register({
      id: 'plugin.cmd.alpha',
      title: 'Alpha',
      fn: vi.fn(),
    });
    const { container } = render(<PluginsTabContent />);
    expect(container.textContent).toContain('plugin.cmd.alpha');
  });

  it('动态注册 → useEffect subscribe 更新', () => {
    const { container } = render(<PluginsTabContent />);
    expect(container.textContent).not.toContain('plugin.late');
    act(() => {
      coApp.commands.register({
        id: 'plugin.late',
        title: 'L',
        fn: vi.fn(),
      });
    });
    expect(container.textContent).toContain('plugin.late');
  });
});

describe('PluginsTabContent — 内置插件', () => {
  it('显示 4 条 core.* 内置插件', () => {
    const { container } = render(<PluginsTabContent />);
    expect(container.textContent).toContain('core.editor');
    expect(container.textContent).toContain('core.terminal');
    expect(container.textContent).toContain('core.output');
    expect(container.textContent).toContain('core.plugins');
  });
});

describe('PluginsTabContent — 第三方插件:空态', () => {
  it('mgr=null → 「暂无第三方插件」', () => {
    installPluginsApi(vi.fn());
    const { container } = render(<PluginsTabContent />);
    // topic-20: 文案改 '暂无用户插件'
    expect(container.textContent).toContain('暂无用户插件');
  });

  it('mgr.listAll()=[] → 「暂无第三方插件」', () => {
    installPluginsApi(vi.fn());
    const fakeMgr: FakeManager = { listAll: () => [] };
    getMgr.mockReturnValue(fakeMgr);
    const { container } = render(<PluginsTabContent />);
    // topic-20: 文案改 '暂无用户插件'
    expect(container.textContent).toContain('暂无用户插件');
  });
});

describe('PluginsTabContent — 第三方插件:列表渲染', () => {
  it('enabled / disabled / failed 三种状态显不同按钮', () => {
    installPluginsApi(vi.fn());
    const fakeMgr: FakeManager = {
      listAll: () => [
        plugin({ id: 'a', status: 'enabled' }),
        plugin({ id: 'b', status: 'disabled' }),
        plugin({ id: 'c', status: 'failed', error: 'EBOOM: kaput' }),
      ],
    };
    getMgr.mockReturnValue(fakeMgr);

    const { container } = render(<PluginsTabContent />);
    const textContent = container.textContent ?? '';
    // enabled → 「禁用」
    expect(textContent).toContain('禁用');
    // disabled & failed 都有「启用」
    const enableBtns = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((b) => b.textContent === '启用');
    expect(enableBtns.length).toBe(2);
    // failed 行有 error
    expect(textContent).toContain('EBOOM');
  });

  it('manifest.permissions 非空 + permStore 存在 → 显「权限」按钮', () => {
    installPluginsApi(vi.fn());
    const fakeMgr: FakeManager = {
      listAll: () => [
        plugin({
          id: 'a',
          status: 'enabled',
          manifest: {
            id: 'a',
            name: 'A',
            version: '0.1.0',
            permissions: ['fs'],
          } as never,
        }),
      ],
    };
    getMgr.mockReturnValue(fakeMgr);
    getPerm.mockReturnValue({
      get: vi.fn().mockResolvedValue([]),
      grant: vi.fn(),
      deny: vi.fn(),
      clearDenied: vi.fn(),
    });
    const { container } = render(<PluginsTabContent />);
    const permBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '权限');
    expect(permBtn).toBeDefined();
  });

  it('manifest.permissions 空 → 不显「权限」按钮', () => {
    installPluginsApi(vi.fn());
    const fakeMgr: FakeManager = {
      listAll: () => [plugin({ id: 'a', status: 'enabled' })],
    };
    getMgr.mockReturnValue(fakeMgr);
    getPerm.mockReturnValue({
      get: vi.fn(),
      grant: vi.fn(),
      deny: vi.fn(),
      clearDenied: vi.fn(),
    });
    const { container } = render(<PluginsTabContent />);
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.textContent === '权限',
      ),
    ).toBeUndefined();
  });

  it('warning 文案显示', () => {
    installPluginsApi(vi.fn());
    const fakeMgr: FakeManager = {
      listAll: () => [
        plugin({
          id: 'a',
          status: 'enabled',
          warning: '某 API 已 deprecated',
        }),
      ],
    };
    getMgr.mockReturnValue(fakeMgr);
    const { container } = render(<PluginsTabContent />);
    expect(container.textContent).toContain('某 API 已 deprecated');
  });
});

describe('PluginsTabContent — 启用/禁用/重载', () => {
  it('点禁用 → mgr.disable(id)', async () => {
    installPluginsApi(vi.fn());
    const disable = vi.fn().mockResolvedValue(undefined);
    const fakeMgr: FakeManager = {
      listAll: () => [plugin({ id: 'a', status: 'enabled' })],
      disable,
    };
    getMgr.mockReturnValue(fakeMgr);
    const { container } = render(<PluginsTabContent />);
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '禁用')!;
    fireEvent.click(btn);
    await waitFor(() => {
      expect(disable).toHaveBeenCalledWith('a');
    });
  });

  it('点启用 → mgr.enable(id)', async () => {
    installPluginsApi(vi.fn());
    const enable = vi.fn().mockResolvedValue(undefined);
    const fakeMgr: FakeManager = {
      listAll: () => [plugin({ id: 'b', status: 'disabled' })],
      enable,
    };
    getMgr.mockReturnValue(fakeMgr);
    const { container } = render(<PluginsTabContent />);
    fireEvent.click(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent === '启用')!,
    );
    await waitFor(() => {
      expect(enable).toHaveBeenCalledWith('b');
    });
  });

  it('点重载 → mgr.reload(id)', async () => {
    installPluginsApi(vi.fn());
    const reload = vi.fn().mockResolvedValue(undefined);
    const fakeMgr: FakeManager = {
      listAll: () => [plugin({ id: 'a', status: 'enabled' })],
      reload,
    };
    getMgr.mockReturnValue(fakeMgr);
    const { container } = render(<PluginsTabContent />);
    fireEvent.click(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent === '重载')!,
    );
    await waitFor(() => {
      expect(reload).toHaveBeenCalledWith('a');
    });
  });

  it('启用抛错 → console.warn,UI 不抛', async () => {
    installPluginsApi(vi.fn());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const enable = vi.fn().mockRejectedValue(new Error('permission denied'));
    const fakeMgr: FakeManager = {
      listAll: () => [plugin({ id: 'b', status: 'disabled' })],
      enable,
    };
    getMgr.mockReturnValue(fakeMgr);
    const { container } = render(<PluginsTabContent />);
    fireEvent.click(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent === '启用')!,
    );
    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('enable'),
        expect.any(Error),
      );
    });
  });
});

describe('PluginsTabContent — Git URL 安装', () => {
  it('输入空 → 安装按钮 disabled', () => {
    installPluginsApi(vi.fn());
    const { container } = render(<PluginsTabContent />);
    const installBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '安装')!;
    expect(installBtn.disabled).toBe(true);
  });

  it('输入合法 URL + 安装成功 → installMsg + pendingInstall', async () => {
    const installFromGit = vi.fn().mockResolvedValue({
      ok: true,
      data: { id: 'p.x', name: 'Plugin X', version: '1.0.0' },
    });
    installPluginsApi(installFromGit);
    const { container } = render(<PluginsTabContent />);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'https://github.com/me/plugin.git' },
    });
    const installBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '安装')!;
    fireEvent.click(installBtn);

    await waitFor(() => {
      expect(installFromGit).toHaveBeenCalledWith(
        'https://github.com/me/plugin.git',
      );
    });
    // installFromGit 是 mockResolvedValue,resolve 进 microtask + React 重渲染
    // 还要再一个 tick;不能只等 mock 被调,得 waitFor 直到 UI 反映安装完成
    // 文案。否则在 ubuntu runner 时序紧时会抢输 race(本地 mac 多数赢)。
    await waitFor(() => {
      expect(container.textContent).toContain('已安装 Plugin X v1.0.0');
    });
    expect(container.textContent).toContain('p.x');
    // gitUrl 清空
    expect(input.value).toBe('');
  });

  it('安装失败 ok=false → 「✘ [code] message」', async () => {
    const installFromGit = vi.fn().mockResolvedValue({
      ok: false,
      code: 'CLONE_FAILED',
      message: 'auth required',
    });
    installPluginsApi(installFromGit);
    const { container } = render(<PluginsTabContent />);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'https://github.com/x/p.git' },
    });
    fireEvent.click(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent === '安装')!,
    );
    await waitFor(() => {
      expect(container.textContent).toContain('CLONE_FAILED');
      expect(container.textContent).toContain('auth required');
    });
  });

  it('安装抛错 → 「✘ ${err.message}」', async () => {
    const installFromGit = vi.fn().mockRejectedValue(new Error('network down'));
    installPluginsApi(installFromGit);
    const { container } = render(<PluginsTabContent />);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: 'https://github.com/x/p.git' },
    });
    fireEvent.click(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent === '安装')!,
    );
    await waitFor(() => {
      expect(container.textContent).toContain('network down');
    });
  });
});

describe('PluginsTabContent — 卸载流程', () => {
  it('点卸载 → 弹 ConfirmDialog', () => {
    installPluginsApi(vi.fn());
    const fakeMgr: FakeManager = {
      listAll: () => [plugin({ id: 'p.del', status: 'disabled' })],
      uninstall: vi.fn(),
    };
    getMgr.mockReturnValue(fakeMgr);
    const { container } = render(<PluginsTabContent />);
    fireEvent.click(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent === '卸载')!,
    );
    expect(document.querySelector('.wm-modal-content')).not.toBeNull();
    expect(document.querySelector('.wm-modal-content')!.textContent).toContain(
      'p.del',
    );
  });

  it('Confirm 确认 → mgr.uninstall(id)', async () => {
    installPluginsApi(vi.fn());
    const uninstall = vi.fn().mockResolvedValue(undefined);
    const fakeMgr: FakeManager = {
      listAll: () => [plugin({ id: 'p.del', status: 'disabled' })],
      uninstall,
    };
    getMgr.mockReturnValue(fakeMgr);
    const { container } = render(<PluginsTabContent />);
    fireEvent.click(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent === '卸载')!,
    );
    const dialogConfirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '.wm-modal-content button',
      ),
    ).find((b) => b.textContent === '卸载')!;
    fireEvent.click(dialogConfirm);
    await waitFor(() => {
      expect(uninstall).toHaveBeenCalledWith('p.del');
    });
  });

  it('卸载抛 → 「✘ 卸载失败」message', async () => {
    installPluginsApi(vi.fn());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const uninstall = vi.fn().mockRejectedValue(new Error('busy'));
    const fakeMgr: FakeManager = {
      listAll: () => [plugin({ id: 'p.del', status: 'disabled' })],
      uninstall,
    };
    getMgr.mockReturnValue(fakeMgr);
    const { container } = render(<PluginsTabContent />);
    fireEvent.click(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent === '卸载')!,
    );
    fireEvent.click(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '.wm-modal-content button',
        ),
      ).find((b) => b.textContent === '卸载')!,
    );
    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
      expect(container.textContent).toContain('卸载失败');
    });
  });
});
