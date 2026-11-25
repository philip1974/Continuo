// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, cleanup, act, waitFor } from '@testing-library/react';
import { t } from '../../i18n';
import { HeaderActions } from '../../shell/dock/HeaderActions';
import { coApp } from '../../plugins/co-app';
import { PanelRegistry } from '../../plugins/registries/PanelRegistry';
import { notify } from '../../notifications/notify';
import type { DockviewApi } from 'dockview-react';
import { setDockApi } from '../../shell/dock/dock-api-ref';
import { toggleSettingsPanel } from '../../lib/toggle-settings-panel';
import { bootCorePlugins, shutdownCorePlugins } from '../../core-plugins';

const createUserTerminalMock = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null));
vi.mock('../../shell/dock/create-user-terminal', () => ({ createUserTerminal: createUserTerminalMock }));

const notifyError = vi.fn();
vi.mock('../../notifications/notify', () => ({
  notify: { error: (...a: unknown[]) => notifyError(...a) },
}));

interface FakeApi {
  addPanel: ReturnType<typeof vi.fn>;
  getPanel: ReturnType<typeof vi.fn>;
  addPopoutGroup: ReturnType<typeof vi.fn>;
}

interface TestProps {
  containerApi: FakeApi;
  group: { id: string; api: { location: { type: string } } };
  activePanel: { id: string; api?: { isActive: boolean } } | null;
}

function makeProps(over: {
  containerApi?: Partial<FakeApi>;
  activePanel?: { id: string; api?: { isActive: boolean } } | null;
  group?: TestProps['group'];
} = {}): TestProps {
  const containerApi: FakeApi = {
    addPanel: vi.fn(),
    getPanel: vi.fn(() => undefined),
    // addPopoutGroup 真实返回 Promise<boolean>(A50:调用点 .catch 失败反馈),默认 resolve。
    addPopoutGroup: vi.fn(() => Promise.resolve(true)),
    ...over.containerApi,
  };
  return {
    containerApi,
    group: over.group ?? { id: 'g1', api: { location: { type: 'grid' } } },
    activePanel: over.activePanel ?? null,
  };
}

beforeEach(() => {
  (coApp as { panels: PanelRegistry }).panels = new PanelRegistry();
});

afterEach(() => cleanup());

describe('HeaderActions — popout', () => {
  it('静态按钮图标预创建且 label 翻译结果复用', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/shell/dock/HeaderActions.tsx'),
      'utf8',
    );

    expect(src).toContain('const POPOUT_ICON = (');
    expect(src).toMatch(/^const MORE_ACTIONS_ICON = \(?</m);
    expect(src).toContain('const popoutLabel = t(');
    expect(src).toContain('const moreActionsLabel = t(');
    expect(src).toContain('aria-label={popoutLabel}');
    expect(src).toContain('title={popoutLabel}');
    expect(src).toContain('aria-label={moreActionsLabel}');
    expect(src).toContain('title={moreActionsLabel}');
    expect(src).toContain('{POPOUT_ICON}');
    expect(src).toContain('{MORE_ACTIONS_ICON}');
  });

  it('activePanel=null → popout 按钮 disabled', () => {
    const props = makeProps({ activePanel: null });
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    const popoutBtn = container.querySelector(
      `button[aria-label="${t('shell.dock.popout_title')}"]`,
    ) as HTMLButtonElement;
    expect(popoutBtn.disabled).toBe(true);
  });

  it('activePanel 有 → 点击调 addPopoutGroup', () => {
    const props = makeProps({ activePanel: { id: 'p1', api: { isActive: false } } });
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    const popoutBtn = container.querySelector(
      `button[aria-label="${t('shell.dock.popout_title')}"]`,
    ) as HTMLButtonElement;
    fireEvent.click(popoutBtn);
    expect(props.containerApi.addPopoutGroup).toHaveBeenCalledTimes(1);
    expect(props.containerApi.addPopoutGroup).toHaveBeenCalledWith(
      props.activePanel,
      expect.objectContaining({ popoutUrl: expect.any(String) }),
    );
  });

  // a11y(A50,A46-A49 同族):popout 失败(addPopoutGroup reject)须 notify.error 反馈,不静默。
  it('a11y · addPopoutGroup reject → notify.error', async () => {
    notifyError.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const props = makeProps({
      activePanel: { id: 'p1' },
      containerApi: {
        addPopoutGroup: vi.fn(() => Promise.reject(new Error('no window'))),
      },
    });
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('shell.dock.popout_title')}"]`,
      ) as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledTimes(1);
    });
  });
});

describe('HeaderActions — popout 被拦截', () => {
  // dockview 在弹窗被拦截(window.open 返 null / 窗口立即被关)时 addPopoutGroup resolve false 而非 reject;
  // false 须与 reject 一样走 popout_failed 反馈。
  it('addPopoutGroup resolve false → notify.error(popout_failed)', async () => {
    notifyError.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const props = makeProps({
      activePanel: { id: 'p1' },
      containerApi: { addPopoutGroup: vi.fn(() => Promise.resolve(false)) },
    });
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('shell.dock.popout_title')}"]`,
      ) as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(t('shell.dock.popout_failed'));
    });
  });

  it('addPopoutGroup resolve true → 不报错', async () => {
    notifyError.mockReset();
    const props = makeProps({ activePanel: { id: 'p1', api: { isActive: false } } });
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('shell.dock.popout_title')}"]`,
      ) as HTMLButtonElement,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyError).not.toHaveBeenCalled();
  });
});

describe('HeaderActions — 更多操作菜单', () => {
  it('默认 open=false → 不渲染 menu', () => {
    const props = makeProps();
    render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  // a11y(A7,A6 同族):Dock 菜单触发按钮须 aria-haspopup=menu + aria-expanded 随开合切换。
  it('a11y · 「更多」按钮有 aria-haspopup=menu + aria-expanded 切换', () => {
    const props = makeProps();
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    const moreBtn = container.querySelector(
      `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
    ) as HTMLButtonElement;
    expect(moreBtn.getAttribute('aria-haspopup')).toBe('menu');
    expect(moreBtn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(moreBtn);
    expect(moreBtn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(moreBtn);
    expect(moreBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('点击「更多」→ 渲染 menu,列出 PanelRegistry 全部 type', () => {
    coApp.panels.register({
      type: 'explorer',
      title: 'Explorer',
      factory: () => null,
    });
    coApp.panels.register({
      type: 'terminal',
      title: 'Terminal',
      factory: () => null,
    });
    const props = makeProps();
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
      ) as HTMLButtonElement,
    );
    const menu = document.querySelector('[role=menu]');
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain('Explorer');
    expect(menu!.textContent).toContain('Terminal');
  });

  it('点 menu item(多实例类型)→ addPanel({id,component,title,position}) + 关菜单', () => {
    coApp.panels.register({
      type: 'explorer',
      title: 'Explorer',
      multiInstance: true,
      factory: () => null,
    });
    const props = makeProps();
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
      ) as HTMLButtonElement,
    );
    const item = document.querySelector('[role=menuitem]') as HTMLElement;
    fireEvent.click(item);

    expect(props.containerApi.addPanel).toHaveBeenCalledTimes(1);
    const arg = props.containerApi.addPanel.mock.calls[0]![0] as {
      id: string;
      component: string;
      title: string;
    };
    expect(arg.component).toBe('explorer');
    expect(arg.title).toBe('Explorer');
    expect(arg.id).toMatch(/^explorer-\d+$/);

    // menu 关闭
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  // 计数器每次启动归零,而持久化布局会恢复 `output-1` 这类 id;dockview 对重复 id 直接抛错。
  it('生成的 panel id 已被占用(重启后恢复的面板)→ 跳过,用下一个空闲 id', () => {
    coApp.panels.register({ type: 'explorer', title: 'Explorer', multiInstance: true, factory: () => null });
    const taken = new Set<string>();
    const props = makeProps({
      containerApi: { getPanel: vi.fn((id: string) => (taken.has(id) ? { id } : undefined)) },
    });
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    const more = container.querySelector(
      `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
    ) as HTMLButtonElement;
    fireEvent.click(more);
    fireEvent.click(document.querySelector('[role=menuitem]') as HTMLElement);
    const first = (props.containerApi.addPanel.mock.calls[0]![0] as { id: string }).id;
    const n = Number(first.split('-')[1]);
    // 下两个序号都已被占用
    taken.add(`explorer-${n + 1}`);
    taken.add(`explorer-${n + 2}`);

    fireEvent.click(more);
    fireEvent.click(document.querySelector('[role=menuitem]') as HTMLElement);
    const second = (props.containerApi.addPanel.mock.calls[1]![0] as { id: string }).id;
    expect(second).toBe(`explorer-${n + 3}`);
  });

  it('addPanel 抛错 → 菜单仍关闭 + notify.error(不留 unhandled rejection)', async () => {
    coApp.panels.register({ type: 'explorer', title: 'Explorer', factory: () => null });
    const notifyError = vi.spyOn(notify, 'error').mockImplementation(() => 'id');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const props = makeProps({
        containerApi: {
          addPanel: vi.fn(() => {
            throw new Error('panel with id already exists');
          }),
        },
      });
      const { container } = render(
        <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
      );
      fireEvent.click(
        container.querySelector(
          `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
        ) as HTMLButtonElement,
      );
      fireEvent.click(document.querySelector('[role=menuitem]') as HTMLElement);
      await vi.waitFor(() => {
        expect(notifyError).toHaveBeenCalledWith(t('shell.dock.add_panel_failed'));
      });
      expect(document.querySelector('[role=menu]')).toBeNull();
      // 失败分支焦点还给触发按钮(不落到 body)
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        t('panels.explorer.btn.more_actions'),
      );
    } finally {
      notifyError.mockRestore();
      warn.mockRestore();
    }
  });

  it('新建终端失败(createUserTerminal 返回 null)→ 关菜单并把焦点还给触发按钮', async () => {
    coApp.panels.register({ type: 'terminal', title: 'Terminal', factory: () => null });
    createUserTerminalMock.mockResolvedValueOnce(null);
    const { container } = render(
      <HeaderActions {...(makeProps() as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
      ) as HTMLButtonElement,
    );
    fireEvent.click(document.querySelector('[role=menuitem]') as HTMLElement);
    await vi.waitFor(() => expect(document.querySelector('[role=menu]')).toBeNull());
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      t('panels.explorer.btn.more_actions'),
    );
  });

  // race(R60,R59 同族):菜单打开期间该 panel type 被插件 unregister(快照仍渲染该项,但 live
  // get 返 undefined)→ 点击不创建已不存在 component 的 panel,关菜单。
  it('R60 菜单打开期 panel type 已 unregister(live get=undefined)→ 不 addPanel + 关菜单', () => {
    coApp.panels.register({ type: 'explorer', title: 'Explorer', factory: () => null });
    const props = makeProps();
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
      ) as HTMLButtonElement,
    );
    const item = document.querySelector('[role=menuitem]') as HTMLElement;
    // 模拟菜单打开期间该 type 被 unregister:snapshot 仍渲染该项,但 live get 返 undefined。
    vi.spyOn(coApp.panels, 'get').mockReturnValue(undefined);
    fireEvent.click(item);

    expect(props.containerApi.addPanel).not.toHaveBeenCalled();
    expect(document.querySelector('[role=menu]')).toBeNull(); // 关菜单
  });

  it('文档 pointerdown 在 ref 之外 → 关菜单', () => {
    coApp.panels.register({
      type: 'x',
      title: 'X',
      factory: () => null,
    });
    const props = makeProps();
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
      ) as HTMLButtonElement,
    );
    expect(document.querySelector('[role=menu]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      );
    });
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  it('subscribe → 后注册的 panel 立即出现在 menu', () => {
    const props = makeProps();
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
      ) as HTMLButtonElement,
    );
    expect(document.querySelector('[role=menu]')!.textContent).not.toContain(
      'NewType',
    );

    act(() => {
      coApp.panels.register({
        type: 'newtype',
        title: 'NewType',
        factory: () => null,
      });
    });
    expect(document.querySelector('[role=menu]')!.textContent).toContain(
      'NewType',
    );
  });
});

// 单例面板(PanelSpec 未声明 multiInstance:editor / settings / 插件面板):其它入口(⌘, toggle、
// DockShell editor 激活、app.dock.openPanel)都按固定 id = type 打开。⋯ 菜单若另生成 `settings-1` /
// `editor-1`,⌘, 关不掉它反而再开一个;两个 EditorPanel 各挂一份编辑器互相覆盖内容。
describe('HeaderActions — 单例面板类型', () => {
  interface FakePanel {
    id: string;
    api: { id: string; isActive: boolean; setActive: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  }
  function makeDock() {
    const panels = new Map<string, FakePanel>();
    const addPanel = vi.fn((opts: { id: string }) => {
      if (panels.has(opts.id)) throw new Error(`panel with id ${opts.id} already exists`);
      const panel: FakePanel = {
        id: opts.id,
        api: {
          id: opts.id,
          isActive: true,
          setActive: vi.fn(),
          close: vi.fn(() => panels.delete(opts.id)),
        },
      };
      panels.set(opts.id, panel);
      return panel;
    });
    const getPanel = vi.fn((id: string) => panels.get(id));
    return { panels, addPanel, getPanel };
  }
  function openMenuAndPick(container: HTMLElement, label: string): void {
    fireEvent.click(
      container.querySelector(
        `button[aria-label="${t('panels.explorer.btn.more_actions')}"]`,
      ) as HTMLButtonElement,
    );
    const item = [...document.querySelectorAll('[role=menuitem]')].find(
      (el) => el.textContent === label,
    ) as HTMLElement;
    fireEvent.click(item);
  }

  afterEach(() => setDockApi(null));

  it.each([
    ['editor', 'Editor'],
    ['settings', 'Settings'],
  ])('⋯ 打开 %s 两次 → 只一个面板(id = type),第二次聚焦已有', (type, title) => {
    coApp.panels.register({ type, title, factory: () => null });
    const dock = makeDock();
    const props = makeProps({ containerApi: { addPanel: dock.addPanel, getPanel: dock.getPanel } });
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    openMenuAndPick(container, title);
    expect(dock.addPanel).toHaveBeenCalledTimes(1);
    expect(dock.addPanel.mock.calls[0]![0]).toMatchObject({
      id: type,
      component: type,
      position: { referenceGroup: props.group },
    });

    // 用户随后切到别的组(面板不再活动)再从 ⋯ 打开:聚焦已有。已是活动组里的活动面板时 activateDockPanel 不重复
    // setActive(见 keyboard-focus-parity/reactivate-active-panel)。
    dock.panels.get(type)!.api.isActive = false;
    openMenuAndPick(container, title);
    expect(dock.addPanel).toHaveBeenCalledTimes(1);
    expect([...dock.panels.keys()]).toEqual([type]);
    expect(dock.panels.get(type)!.api.setActive).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role=menu]')).toBeNull();
  });

  it('插件面板(未声明 multiInstance)同为单例,与 app.dock.openPanel 的固定 id 一致', () => {
    coApp.panels.register({ type: 'acme.viewer', title: 'Viewer', factory: () => null });
    const dock = makeDock();
    const props = makeProps({ containerApi: { addPanel: dock.addPanel, getPanel: dock.getPanel } });
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    openMenuAndPick(container, 'Viewer');
    openMenuAndPick(container, 'Viewer');
    expect([...dock.panels.keys()]).toEqual(['acme.viewer']);
  });

  it('⋯ 打开的 Settings 能被 ⌘,(toggleSettingsPanel)切换关闭,且不另开一个', () => {
    coApp.panels.register({ type: 'settings', title: 'Settings', factory: () => null });
    const dock = makeDock();
    const props = makeProps({ containerApi: { addPanel: dock.addPanel, getPanel: dock.getPanel } });
    setDockApi(props.containerApi as unknown as DockviewApi);
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    openMenuAndPick(container, 'Settings');
    const opened = dock.panels.get('settings')!;
    expect(opened).toBeDefined();

    toggleSettingsPanel();
    expect(opened.api.close).toHaveBeenCalledTimes(1);
    expect(dock.addPanel).toHaveBeenCalledTimes(1);
    expect(dock.panels.size).toBe(0);
  });

  it('多实例类型(multiInstance: true)仍每次新开不同 id', () => {
    coApp.panels.register({ type: 'output', title: 'Output', multiInstance: true, factory: () => null });
    const dock = makeDock();
    const props = makeProps({ containerApi: { addPanel: dock.addPanel, getPanel: dock.getPanel } });
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    openMenuAndPick(container, 'Output');
    openMenuAndPick(container, 'Output');
    expect(dock.panels.size).toBe(2);
    for (const id of dock.panels.keys()) expect(id).toMatch(/^output-\d+$/);
  });

  it('terminal 仍可多开:每次都走 createUserTerminal', async () => {
    coApp.panels.register({ type: 'terminal', title: 'Terminal', multiInstance: true, factory: () => null });
    createUserTerminalMock.mockReset();
    createUserTerminalMock.mockResolvedValue('t-x');
    const dock = makeDock();
    const props = makeProps({ containerApi: { addPanel: dock.addPanel, getPanel: dock.getPanel } });
    const { container } = render(
      <HeaderActions {...(props as unknown as Parameters<typeof HeaderActions>[0])} />,
    );
    openMenuAndPick(container, 'Terminal');
    await vi.waitFor(() => expect(document.querySelector('[role=menu]')).toBeNull());
    openMenuAndPick(container, 'Terminal');
    await vi.waitFor(() => expect(createUserTerminalMock).toHaveBeenCalledTimes(2));
    expect(dock.addPanel).not.toHaveBeenCalled();
  });

  it('内置面板标记:terminal / output / debug 多实例,editor / settings 单例', async () => {
    await bootCorePlugins();
    try {
      const multi = (type: string) => coApp.panels.get(type)?.multiInstance === true;
      expect(coApp.panels.get('editor')).toBeDefined();
      expect(multi('editor')).toBe(false);
      expect(multi('settings')).toBe(false);
      expect(multi('terminal')).toBe(true);
      expect(multi('output')).toBe(true);
      expect(multi('debug')).toBe(true);
    } finally {
      await shutdownCorePlugins();
    }
  });
});

// 旧版「⋯」菜单曾多开出 `editor-1` / `settings-1`:恢复布局后关闭单例类型中 id ≠ type 的实例(多实例类型、未注册类型不动)。
describe('closeDuplicateSingletonPanels', () => {
  it('关闭单例的非固定 id 实例;保留固定 id、多实例类型与未注册类型', async () => {
    const { closeDuplicateSingletonPanels } = await import('../../shell/dock/DockShell');
    const mk = (id: string, type: string) => ({ id, view: { contentComponent: type }, api: { close: vi.fn() } });
    const list = [
      mk('editor', 'editor'),
      mk('editor-1', 'editor'),
      mk('settings-2', 'settings'),
      mk('terminal-3', 'terminal'),
      mk('git.viewer-1', 'git.viewer'),
    ];
    const specs: Record<string, { multiInstance?: boolean }> = {
      editor: {},
      settings: {},
      terminal: { multiInstance: true },
    };
    closeDuplicateSingletonPanels({ panels: list } as never, { get: (t) => specs[t] });
    expect(list.map((p) => p.api.close.mock.calls.length)).toEqual([0, 1, 1, 0, 0]);
  });
  it('接线:DockShell 恢复布局后调用(与清理旧 explorer 面板同处)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(`${process.cwd()}/src/shell/dock/DockShell.tsx`, 'utf8');
    expect(src).toContain('closeDuplicateSingletonPanels(event.api, coApp.panels)');
  });
});

