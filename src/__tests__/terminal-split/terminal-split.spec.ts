// @vitest-environment jsdom
// BDD: terminal-split —— 拆分终端(VSCode workbench.action.terminal.split):命令 / 默认键 / 终端获焦时压过拆分编辑器、
// 父终端旁的落点(主窗右侧新组;popout 留在子窗)、cwd 继承父终端、菜单入口。见同目录 README。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi, IDockviewPanel } from 'dockview-react';

const h = vi.hoisted(() => ({
  /** createUserTerminal 的替身:按 onCreate 模拟 session 推送早于 / 晚于 RPC 返回。 */
  onCreate: null as null | ((opts: { cwd?: string }) => void),
  nextId: 'b',
}));
vi.mock('../../shell/dock/create-user-terminal', () => ({
  createUserTerminal: vi.fn(async (opts: { cwd?: string } = {}) => {
    h.onCreate?.(opts);
    return h.nextId;
  }),
  terminalColorFgBg: () => '15;0',
}));
vi.mock('@/notifications/notify', () => ({
  notify: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { createUserTerminal } from '@/shell/dock/create-user-terminal';
import { setDockApi } from '@/shell/dock/dock-api-ref';
import { __resetReconcilerForTest, reconcileTerminalPanels } from '@/shell/dock/DockReconciler';
import { splitActiveTerminal, splitTerminalPanel } from '@/shell/dock/terminal-split';
import {
  TERMINAL_SPLIT_COMMAND_ID,
  terminalSplitDefaultHotkeys,
  terminalYieldedCommandId,
} from '@/panels/Terminal/terminal-hotkeys';
import { winningCommandFor } from '@/plugins/command-palette/useCommandHotkeys';
import { TERMINAL_ATTR } from '@/lib/editor-text-focus';
import type { Platform } from '@/plugins/command-palette/format-hotkey';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { editorCommandSpecs } from '@/panels/Editor/editor-commands';
import { useTerminalStore, type TerminalSession } from '@/stores/terminal.store';
import { MENU_COMMAND_IDS } from '../../../electron/shared/window-channels';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';
import { makeSession } from '../dock-reconciler-windowid-filter/fixtures';
import { createDock, openFakePopout } from '../dock-terminal-vscode-focus/dock-fixtures';

const SPLIT = TERMINAL_SPLIT_COMMAND_ID;
const SPLIT_EDITOR = 'workbench.action.splitEditor';

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());
beforeEach(() => {
  __resetReconcilerForTest();
  h.onCreate = null;
  h.nextId = 'b';
  vi.mocked(createUserTerminal).mockClear();
});
afterEach(() => {
  setDockApi(null);
  useTerminalStore.setState({ sessions: [] });
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('命令', () => {
  it('workbench.action.terminal.split:三语标题、类别终端、限终端焦点', () => {
    const spec = coApp.commands.get(SPLIT);
    expect(spec).toBeDefined();
    expect(spec!.when).toBe('terminalFocus');
    expect(spec!.categoryKey).toBe('commands.terminal.category');
    const k = spec!.titleKey as keyof typeof en;
    expect([en[k], zh[k], ko[k]]).toEqual(['Split Terminal', '拆分终端', '터미널 분할']);
  });

  it.each([
    ['mac', 'mod+\\', ['ctrl+shift+5']],
    ['other', 'ctrl+shift+5', undefined],
  ] as const)('%s 默认键同 VSCode', (platform, hotkey, secondary) => {
    const keys = terminalSplitDefaultHotkeys(platform);
    expect(keys.hotkey).toBe(hotkey);
    expect(keys.secondaryHotkeys).toEqual(secondary);
  });

  it('「终端」菜单与三语菜单文案', () => {
    expect(MENU_COMMAND_IDS).toContain(SPLIT);
    for (const cat of [en, zh, ko] as Array<Record<string, string>>) expect(cat['menu.terminal.split_terminal']).toBeTruthy();
  });
});

describe('按键:终端里拆分终端,编辑器里仍拆分编辑器', () => {
  function commandsFor(platform: Platform): CommandSpec[] {
    const split = { ...coApp.commands.get(SPLIT)!, ...terminalSplitDefaultHotkeys(platform) };
    const own = [...editorCommandSpecs(platform), split];
    const ids = new Set(own.map((c) => c.id));
    return [...own, ...coApp.commands.getAll().filter((c) => !ids.has(c.id))];
  }
  function targets() {
    const host = document.createElement('div');
    host.setAttribute(TERMINAL_ATTR, '');
    const term = document.createElement('textarea');
    host.appendChild(term);
    const ed = document.createElement('div');
    ed.setAttribute('contenteditable', 'true');
    document.body.append(host, ed);
    return { term, ed };
  }
  const press = (target: EventTarget, init: KeyboardEventInit): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };
  const CMD_BACKSLASH = { key: '\\', code: 'Backslash', metaKey: true };
  const CTRL_SHIFT_5 = { key: '%', code: 'Digit5', ctrlKey: true, shiftKey: true };

  it('mac:终端里 ⌘\\ / ⌃⇧5 胜出的是拆分终端并让出(不发给 shell);编辑器里 ⌘\\ 是拆分编辑器', () => {
    const { term, ed } = targets();
    const all = commandsFor('mac');
    const registry = { getAll: () => all };
    expect(winningCommandFor(press(term, CMD_BACKSLASH), all, 'mac', {})?.id).toBe(SPLIT);
    expect(terminalYieldedCommandId(press(term, CMD_BACKSLASH), 'mac', {}, registry)).toBe(SPLIT);
    expect(terminalYieldedCommandId(press(term, CTRL_SHIFT_5), 'mac', {}, registry)).toBe(SPLIT);
    expect(winningCommandFor(press(ed, CMD_BACKSLASH), all, 'mac', {})?.id).toBe(SPLIT_EDITOR);
  });

  it('Windows / Linux:终端里 Ctrl+Shift+5 拆分终端并让出;Ctrl+\\ 仍进 shell(SIGQUIT)', () => {
    const { term } = targets();
    const all = commandsFor('other');
    const registry = { getAll: () => all };
    expect(terminalYieldedCommandId(press(term, CTRL_SHIFT_5), 'other', {}, registry)).toBe(SPLIT);
    expect(terminalYieldedCommandId(press(term, { key: '\\', code: 'Backslash', ctrlKey: true }), 'other', {}, registry)).toBeNull();
  });
});

describe('落点与 cwd', () => {
  /** 主窗:a | c(a 不是最后一个终端:新建终端默认会追加到 c 右边,拆分 a 应紧挨 a 右侧)。 */
  function setup() {
    const dock = createDock();
    const api = dock.api as DockviewApi;
    api.layout(1200, 600, true);
    setDockApi(api);
    const a = makeSession('a', { createdAt: 1, cwd: '/repo/sub' });
    const c = makeSession('c', { createdAt: 2 });
    reconcileTerminalPanels(api, { previousSessions: [], nextSessions: [a, c] });
    let sessions: TerminalSession[] = [a, c];
    useTerminalStore.setState({ sessions });
    /** main 推来新的会话快照。 */
    const push = (...added: TerminalSession[]) => {
      const next = [...sessions, ...added];
      reconcileTerminalPanels(api, { previousSessions: sessions, nextSessions: next });
      sessions = next;
      useTerminalStore.setState({ sessions });
    };
    return { dock, api, push };
  }

  /** 主窗 grid 的组(从左到右)各自的面板 id。 */
  function gridColumns(api: DockviewApi): string[][] {
    const order: string[] = [];
    const walk = (node: { type: string; data: unknown }): void => {
      if (node.type === 'leaf') order.push((node.data as { id: string }).id);
      else for (const child of node.data as { type: string; data: unknown }[]) walk(child);
    };
    walk(api.toJSON().grid.root as { type: string; data: unknown });
    return order.map((id) => api.getGroup(id)!.panels.map((p: IDockviewPanel) => p.id));
  }

  it('session 推送晚于 RPC 返回:新终端在父终端组右侧的新组;cwd = 父终端当前目录', async () => {
    const { api, push } = setup();
    await splitTerminalPanel('terminal-a');
    expect(createUserTerminal).toHaveBeenCalledWith({ cwd: '/repo/sub' });
    push(makeSession('b', { createdAt: 3 }));
    expect(gridColumns(api)).toEqual([['terminal-a'], ['terminal-b'], ['terminal-c']]);
  });

  it('session 推送早于 RPC 返回:同样落在父终端右侧', async () => {
    const { api, push } = setup();
    h.onCreate = () => push(makeSession('b', { createdAt: 3 }));
    await splitTerminalPanel('terminal-a');
    expect(gridColumns(api)).toEqual([['terminal-a'], ['terminal-b'], ['terminal-c']]);
  });

  it('拆分期间出现的 agent 终端不占用落点(照常追加),之后到达的新终端仍落在父终端右侧', async () => {
    const { api, push } = setup();
    h.onCreate = () => push(makeSession('agent', { createdAt: 3, originHint: 'agent' }));
    await splitTerminalPanel('terminal-a');
    push(makeSession('b', { createdAt: 4 }));
    expect(gridColumns(api)).toEqual([['terminal-a'], ['terminal-b'], ['terminal-c'], ['terminal-agent']]);
  });

  /** main 端 terminal.cwd 的替身(preload 未注入时 coApi 回退 window.api)。 */
  function stubMainCwd(impl: (id: string) => Promise<unknown>) {
    const cwd = vi.fn(impl);
    vi.stubGlobal('api', { terminal: { cwd } });
    return cwd;
  }

  it('cwd 取 main 端 terminal.cwd(shell 未上报 OSC 7 时为 shell 进程 `cd` 之后的真实目录),优先于会话 cwd', async () => {
    const { push } = setup();
    const cwd = stubMainCwd(async () => ({ ok: true, data: { cwd: '/repo/sub/deeper' } }));
    await splitTerminalPanel('terminal-a');
    expect(cwd).toHaveBeenCalledWith('a');
    expect(createUserTerminal).toHaveBeenCalledWith({ cwd: '/repo/sub/deeper' });
    push(makeSession('b', { createdAt: 3 }));
  });

  it('main 端取不到(cwd null)→ 不传 cwd(按工作区根新建);查询失败 → 回退会话 cwd', async () => {
    const { push } = setup();
    stubMainCwd(async () => ({ ok: true, data: { cwd: null } }));
    await splitTerminalPanel('terminal-a');
    expect(createUserTerminal).toHaveBeenLastCalledWith({});
    stubMainCwd(async () => {
      throw new Error('ipc down');
    });
    await splitTerminalPanel('terminal-a');
    expect(createUserTerminal).toHaveBeenLastCalledWith({ cwd: '/repo/sub' });
    push(makeSession('b', { createdAt: 3 }));
  });

  it('父终端会话没有 cwd → 不传 cwd(按工作区根新建)', async () => {
    const { push } = setup();
    useTerminalStore.setState({ sessions: [makeSession('a', { cwd: '' }), makeSession('c', { createdAt: 2 })] });
    await splitTerminalPanel('terminal-a');
    expect(createUserTerminal).toHaveBeenCalledWith({});
    push(makeSession('b', { createdAt: 3 }));
  });

  it('父终端在 popout 子窗:新终端加进父终端的组,留在子窗', async () => {
    const { dock, api, push } = setup();
    await openFakePopout(dock, 'terminal-a');
    await splitTerminalPanel('terminal-a');
    push(makeSession('b', { createdAt: 3 }));
    const b = api.getPanel('terminal-b')!;
    expect(b.api.location.type).toBe('popout');
    expect(b.group).toBe(api.getPanel('terminal-a')!.group);
  });

  it('命令:父终端 = 焦点所在 / 活动终端;拆分后焦点(活动面板)是新终端', async () => {
    const { api, push } = setup();
    api.getPanel('terminal-a')!.api.setActive();
    h.onCreate = () => push(makeSession('b', { createdAt: 3 }));
    await coApp.commands.execute(SPLIT);
    expect(createUserTerminal).toHaveBeenCalledWith({ cwd: '/repo/sub' });
    expect(gridColumns(api)).toEqual([['terminal-a'], ['terminal-b'], ['terminal-c']]);
    expect(api.activePanel?.id).toBe('terminal-b');
  });

  it('窗口里没有终端 → 新建终端', async () => {
    const dock = createDock();
    setDockApi(dock.api as DockviewApi);
    await splitActiveTerminal();
    expect(createUserTerminal).toHaveBeenCalledWith();
  });
});
