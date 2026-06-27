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
import { setLocale as setI18nLocale } from '@/i18n';
import {
  PluginsTabContent,
  collectContributionSamples,
  collectStatusBarItems,
  hasPluginId,
  hasPluginVersion,
  pluginsTabRowClassName,
} from '../../plugins/settings/PluginsTabContent';
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
  it('列表行 className 不通过数组 join 重建', () => {
    const joinSpy = vi.spyOn(Array.prototype, 'join');

    try {
      expect(pluginsTabRowClassName(false)).toContain(
        'flex items-start gap-4 px-4 py-3 text-xs',
      );
      expect(pluginsTabRowClassName(false)).not.toContain('border-t');
      expect(pluginsTabRowClassName(true)).toContain('border-t border-line/50');
      expect(joinSpy).not.toHaveBeenCalled();
    } finally {
      joinSpy.mockRestore();
    }
  });

  it('贡献点 samples 预分配收集,不调用 items.map', () => {
    const items = [
      { id: 'command.a', type: 'A' },
      { id: 'command.b', type: 'B' },
    ];
    const mapSpy = vi.spyOn(items, 'map');

    try {
      expect(collectContributionSamples(items, 'id')).toEqual([
        'command.a',
        'command.b',
      ]);
      expect(mapSpy).not.toHaveBeenCalled();
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('状态栏左右贡献预分配合并,不通过数组 spread', () => {
    const left = [{ id: 'left' }];
    const right = [{ id: 'right-a' }, { id: 'right-b' }];

    expect(collectStatusBarItems(left, right).map((item) => item.id)).toEqual([
      'left',
      'right-a',
      'right-b',
    ]);
    expect(collectStatusBarItems.toString()).not.toContain('...');
  });

  it('插件存在性检查单趟扫描,不调用 plugins.some', () => {
    const plugins = [
      plugin({ id: 'alpha', manifest: { id: 'alpha', version: '1.0.0' } as never }),
      plugin({ id: 'beta', manifest: { id: 'beta', version: '2.0.0' } as never }),
    ];
    const someSpy = vi.spyOn(plugins, 'some');

    try {
      expect(hasPluginId(plugins, 'beta')).toBe(true);
      expect(hasPluginId(plugins, 'missing')).toBe(false);
      expect(hasPluginVersion(plugins, 'beta', '2.0.0')).toBe(true);
      expect(hasPluginVersion(plugins, 'beta', '1.0.0')).toBe(false);
      expect(someSpy).not.toHaveBeenCalled();
    } finally {
      someSpy.mockRestore();
    }
  });

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

  // 打磨 R4:snapshot() 把 statusBar 左右两侧合并为一次局部快照统计。两侧各注册
  // 一项,samples 必须同时含左右 id(守护「合并 getBySide 不丢侧」)。
  it('statusBar 左右各注册 → samples 含两侧', () => {
    coApp.statusBar.register({
      id: 'sb.left.one',
      side: 'left',
      render: () => null,
    });
    coApp.statusBar.register({
      id: 'sb.right.one',
      side: 'right',
      render: () => null,
    });
    const { container } = render(<PluginsTabContent />);
    expect(container.textContent).toContain('sb.left.one');
    expect(container.textContent).toContain('sb.right.one');
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
        plugin({ id: 'c', status: 'failed', error: { code: 'EBOOM', message: 'kaput' } }),
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

  // a11y(A95,A94 同族):Plugins Git URL 安装 loading 须 aria-busy + 视觉隐藏 role=status 播报。
  it('a11y · Git URL 安装 loading → 按钮 aria-busy + role=status 播报安装中', async () => {
    const installFromGit = vi.fn().mockReturnValue(new Promise(() => {})); // 永不 resolve
    installPluginsApi(installFromGit);
    getMgr.mockReturnValue({ listAll: () => [] });
    const { container } = render(<PluginsTabContent />);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://github.com/u/p.git' } });
    fireEvent.click(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.textContent === '安装',
      )!,
    );
    await waitFor(() => {
      const busy = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.getAttribute('aria-busy') === 'true');
      expect(busy).toBeDefined();
    });
    const statuses = Array.from(container.querySelectorAll('[role=status]'));
    expect(statuses.some((s) => (s.textContent ?? '').includes('安装中'))).toBe(true);
  });

  // a11y(A75,A2 同族):多插件行的操作按钮可见文本通用(都叫「卸载/禁用」),须 aria-label
  // 含插件名以区分,否则 SR 用户导航时无法知道操作哪个插件(误操作风险)。
  it('a11y · 行操作按钮 aria-label 含插件名(多行可区分)', () => {
    installPluginsApi(vi.fn());
    const fakeMgr: FakeManager = {
      listAll: () => [
        plugin({ id: 'alpha', status: 'enabled' }),
        plugin({ id: 'beta', status: 'enabled' }),
      ],
    };
    getMgr.mockReturnValue(fakeMgr);
    const { container } = render(<PluginsTabContent />);
    const labels = Array.from(container.querySelectorAll('button'))
      .map((b) => b.getAttribute('aria-label') ?? '')
      .filter((l) => l.includes('卸载'));
    // 两个卸载按钮各含各自插件名,可区分
    expect(labels.some((l) => l.includes('alpha'))).toBe(true);
    expect(labels.some((l) => l.includes('beta'))).toBe(true);
  });

  // a11y(A68,A41 同族):插件运行时 error 异步出现须 live region(失败=role=alert)。
  it('a11y · 插件 error → 在 role=alert', () => {
    installPluginsApi(vi.fn());
    const fakeMgr: FakeManager = {
      listAll: () => [
        plugin({ id: 'c', status: 'failed', error: { code: 'EBOOM', message: 'kaput' } }),
      ],
    };
    getMgr.mockReturnValue(fakeMgr);
    const { container } = render(<PluginsTabContent />);
    const alert = container.querySelector('[role=alert]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('EBOOM');
  });

  // a11y(A68):插件运行时 warning(部分授权等)异步出现 → role=status(可覆盖警告=polite)。
  it('a11y · 插件 warning → 在 role=status', () => {
    installPluginsApi(vi.fn());
    const fakeMgr: FakeManager = {
      listAll: () => [
        plugin({
          id: 'a',
          status: 'enabled',
          warning: {
            code: 'plugins_tab.warning.partial_grant',
            params: { granted: 'fs', denied: 'network' },
          },
        }),
      ],
    };
    getMgr.mockReturnValue(fakeMgr);
    const { container } = render(<PluginsTabContent />);
    const statuses = Array.from(container.querySelectorAll('[role=status]'));
    const warn = statuses.find((s) => s.textContent?.includes('部分授权'));
    expect(warn).toBeTruthy();
    // a11y(A84):⚠ 装饰符号须在 aria-hidden span 内,不混进 live region 播报。
    const warnSign = warn!.querySelector('span[aria-hidden="true"]');
    expect(warnSign).not.toBeNull();
    expect(warnSign!.textContent).toContain('⚠');
  });

  // i18n(I4):error 结构化后,catalog 收录的 code(NO_DEFAULT_EXPORT)按 locale 渲染本地化
  // 文案;未收录 code 保留旧 `code: message` 格式。验证 en/zh 各显对应语言,不泄漏中文到 en。
  it('failed error code 在 catalog(NO_DEFAULT_EXPORT)→ 按 locale 渲染本地化', () => {
    installPluginsApi(vi.fn());
    const fakeMgr: FakeManager = {
      listAll: () => [
        plugin({
          id: 'a',
          status: 'failed',
          error: {
            code: 'NO_DEFAULT_EXPORT',
            message: 'Plugin a has no default export', // fallback,不应被显示
          },
        }),
      ],
    };
    getMgr.mockReturnValue(fakeMgr);
    // 默认 zh
    const zh = render(<PluginsTabContent />);
    expect(zh.container.textContent).toContain('没有 export default');
    cleanup();
    // en
    setI18nLocale('en');
    try {
      const en = render(<PluginsTabContent />);
      expect(en.container.textContent).toContain('no default export');
      expect(en.container.textContent).not.toContain('没有');
    } finally {
      setI18nLocale('zh');
    }
  });

  // i18n(I4):catalog 未收录的 code(PERMISSION_DENIED 等动态 message)保留 `code: message`。
  it('failed error code 不在 catalog → 回退 `code: message` 格式', () => {
    installPluginsApi(vi.fn());
    const fakeMgr: FakeManager = {
      listAll: () => [
        plugin({
          id: 'a',
          status: 'failed',
          error: { code: 'PERMISSION_DENIED', message: 'fs, network' },
        }),
      ],
    };
    getMgr.mockReturnValue(fakeMgr);
    const { container } = render(<PluginsTabContent />);
    expect(container.textContent).toContain('PERMISSION_DENIED');
    expect(container.textContent).toContain('fs, network');
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

  // race(R102):权限编辑弹窗打开期间该插件被卸载(轮询刷新后从 listAll 消失)→ 弹窗自动关闭,
  // 防保存把已卸载插件的 ghost 权限写回。
  it('打开权限弹窗后插件被卸载(轮询刷新)→ 弹窗自动关闭', async () => {
    vi.useFakeTimers();
    try {
      installPluginsApi(vi.fn());
      let live: PluginListItem[] = [
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
      ];
      getMgr.mockReturnValue({ listAll: () => live });
      getPerm.mockReturnValue({
        get: vi.fn().mockResolvedValue([]),
        grant: vi.fn(),
        deny: vi.fn(),
        clearDenied: vi.fn(),
      });
      const { container } = render(<PluginsTabContent />);
      const permBtn = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).find((b) => b.textContent === '权限')!;
      act(() => {
        fireEvent.click(permBtn);
      });
      // 弹窗已开(标题渲染)
      expect(document.querySelector('.wm-modal-content')).toBeTruthy();

      // 另一窗口卸载了插件 a → 下次 1s 轮询 listAll 不再含 a
      live = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      // 弹窗因 permEditTarget 从 live 列表消失而自动关闭
      expect(document.querySelector('.wm-modal-content')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  // i18n(I3):warning 改结构化 {code, params},renderer 经 catalog 渲染(默认测试 locale=zh)。
  it('warning 文案显示(结构化 → catalog 渲染)', () => {
    installPluginsApi(vi.fn());
    const fakeMgr: FakeManager = {
      listAll: () => [
        plugin({
          id: 'a',
          status: 'enabled',
          warning: {
            code: 'plugins_tab.warning.partial_grant',
            params: { granted: 'fs', denied: 'network' },
          },
        }),
      ],
    };
    getMgr.mockReturnValue(fakeMgr);
    const { container } = render(<PluginsTabContent />);
    // zh catalog: '部分授权:已授 {granted};未授 {denied}'
    expect(container.textContent).toContain('部分授权');
    expect(container.textContent).toContain('fs');
    expect(container.textContent).toContain('network');
  });

  // i18n(I3):locale=en 时 partial-grant warning 用英文 catalog,不泄漏中文(manager 不再拼中文)。
  it('warning locale=en → 英文 catalog 文案,不泄漏中文', () => {
    setI18nLocale('en');
    try {
      installPluginsApi(vi.fn());
      const fakeMgr: FakeManager = {
        listAll: () => [
          plugin({
            id: 'a',
            status: 'enabled',
            warning: {
              code: 'plugins_tab.warning.partial_grant',
              params: { granted: 'fs', denied: 'network' },
            },
          }),
        ],
      };
      getMgr.mockReturnValue(fakeMgr);
      const { container } = render(<PluginsTabContent />);
      // en catalog: 'Partial grant — granted: {granted}; not granted: {denied}'
      expect(container.textContent).toContain('Partial grant');
      expect(container.textContent).not.toContain('部分授权');
    } finally {
      setI18nLocale('zh');
    }
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
    // a11y(A47):生命周期操作失败须 live region(role=alert)反馈,不只 console.warn。
    await waitFor(() => {
      const alert = container.querySelector('[role=alert]');
      expect(alert).not.toBeNull();
      expect(alert!.textContent).toContain('permission denied');
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
    // a11y(A42):安装成功结果须在 live region(成功=role=status/polite)主动播报。
    // A95 起新增 loading 用 role=status(idle 空)→ 同页多个 role=status,用 .some() 按文本定位。
    const statuses = Array.from(container.querySelectorAll('[role=status]'));
    expect(
      statuses.some((s) => (s.textContent ?? '').includes('已安装 Plugin X')),
    ).toBe(true);
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
    // a11y(A42):安装失败结果须在 live region(失败=role=alert/assertive)主动播报。
    const alert = container.querySelector('[role=alert]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('CLONE_FAILED');
  });

  // i18n(codex 复查 P1):installFromGit 各错误站点的 message 是硬编码中文,经 safeHandle
  // 原样传到 renderer。若直接展示 r.message,en/ko 界面会看到中文。renderer 须按稳定 r.code
  // 经 catalog(errors.<CODE> 三语言齐)翻译;catalog 命中时不得泄漏中文原文。
  it('安装失败 code 在 catalog(BAD_URL)+ locale=en → 显英文文案,不泄漏中文 message', async () => {
    setI18nLocale('en');
    try {
      const installFromGit = vi.fn().mockResolvedValue({
        ok: false,
        code: 'BAD_URL',
        message: '不支持的 git URL: ftp://x', // main 硬编码中文
      });
      installPluginsApi(installFromGit);
      const { container } = render(<PluginsTabContent />);
      const input = container.querySelector('input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'ftp://x' } });
      fireEvent.click(
        Array.from(
          container.querySelectorAll<HTMLButtonElement>('button'),
        ).find((b) => b.textContent === 'Install')!,
      );
      await waitFor(() => {
        // en catalog 的 errors.BAD_URL = 'Bad URL'
        expect(container.textContent).toContain('Bad URL');
      });
      // 中文原文不得泄漏到 en 界面
      expect(container.textContent).not.toContain('不支持的 git URL');
      // code 仍展示(稳定标识,非语言相关)
      expect(container.textContent).toContain('BAD_URL');
    } finally {
      setI18nLocale('zh');
    }
  });

  // catalog 未收录的 code → 回退原始 message(不破坏既有 CLONE_FAILED 行为)。
  it('安装失败 code 不在 catalog(CLONE_FAILED)→ 回退原始 message', async () => {
    const installFromGit = vi.fn().mockResolvedValue({
      ok: false,
      code: 'CLONE_FAILED',
      message: 'auth required',
    });
    installPluginsApi(installFromGit);
    const { container } = render(<PluginsTabContent />);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://github.com/x/p.git' } });
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

  // i18n(I10):uninstall 抛回带 code 的 Error(main RM_FAILED message 是中文「删除失败:…」),
  // catch 须按 code 经 catalog 本地化,locale=en 不泄漏中文。
  it('卸载抛带 code(RM_FAILED 中文 message)+ locale=en → 英文 catalog,不泄漏中文', async () => {
    setI18nLocale('en');
    try {
      installPluginsApi(vi.fn());
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const uninstall = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('删除失败: EACCES'), { code: 'RM_FAILED' }),
        );
      const fakeMgr: FakeManager = {
        listAll: () => [plugin({ id: 'p.del', status: 'disabled' })],
        uninstall,
      };
      getMgr.mockReturnValue(fakeMgr);
      const { container } = render(<PluginsTabContent />);
      fireEvent.click(
        Array.from(
          container.querySelectorAll<HTMLButtonElement>('button'),
        ).find((b) => b.textContent === 'Uninstall')!,
      );
      fireEvent.click(
        Array.from(
          document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
        ).find((b) => b.textContent === 'Uninstall')!,
      );
      await waitFor(() => {
        expect(warn).toHaveBeenCalled();
        // en catalog errors.RM_FAILED = 'Remove failed'
        expect(container.textContent).toContain('Remove failed');
      });
      expect(container.textContent).not.toContain('删除失败'); // 不泄漏中文
    } finally {
      setI18nLocale('zh');
    }
  });

  // race(R103,R102 同族):卸载确认弹窗打开期间该插件被卸载(轮询刷新后从 listAll 消失)→ 弹窗自动
  // 关闭,防迟到确认删错实例。
  it('打开卸载弹窗后插件消失(轮询刷新)→ 弹窗自动关闭', async () => {
    vi.useFakeTimers();
    try {
      installPluginsApi(vi.fn());
      let live: PluginListItem[] = [plugin({ id: 'p.del', status: 'disabled' })];
      getMgr.mockReturnValue({ listAll: () => live, uninstall: vi.fn() });
      const { container } = render(<PluginsTabContent />);
      act(() => {
        fireEvent.click(
          Array.from(
            container.querySelectorAll<HTMLButtonElement>('button'),
          ).find((b) => b.textContent === '卸载')!,
        );
      });
      expect(document.querySelector('.wm-modal-content')).not.toBeNull();
      live = []; // 另一窗口已卸载
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(document.querySelector('.wm-modal-content')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // race(R103):卸载确认弹窗打开期间该插件被卸载+重装成不同 version(=不同实例,id 仍在但 version 变)
  // → effect 因 id+version 不再匹配自动关弹窗,防迟到确认删掉用户从未确认的新实例。
  it('打开卸载弹窗后插件被重装成不同 version(轮询刷新)→ 弹窗自动关闭', async () => {
    vi.useFakeTimers();
    try {
      installPluginsApi(vi.fn());
      let live: PluginListItem[] = [
        plugin({
          id: 'p.del',
          status: 'disabled',
          manifest: { id: 'p.del', name: 'p.del', version: '1.0.0' } as never,
        }),
      ];
      getMgr.mockReturnValue({ listAll: () => live, uninstall: vi.fn() });
      const { container } = render(<PluginsTabContent />);
      act(() => {
        fireEvent.click(
          Array.from(
            container.querySelectorAll<HTMLButtonElement>('button'),
          ).find((b) => b.textContent === '卸载')!,
        );
      });
      expect(document.querySelector('.wm-modal-content')).not.toBeNull();
      // 另一窗口卸载+重装同 id 但不同 version(新实例)
      live = [
        plugin({
          id: 'p.del',
          status: 'disabled',
          manifest: { id: 'p.del', name: 'p.del', version: '2.0.0' } as never,
        }),
      ];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(document.querySelector('.wm-modal-content')).toBeNull(); // 不同实例 → 关弹窗
    } finally {
      vi.useRealTimers();
    }
  });
});
