// @vitest-environment jsdom
// BDD:F6 / ⇧F6 在工作台区域间循环(VSCode workbench.action.focusNextPart / focusPreviousPart);终端让出 F6;
// 编辑器里 F6 照常触发命令。见同目录 README 第 6 条。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { DockviewComponent, type DockviewApi } from 'dockview-react';
import {
  FOCUS_NEXT_PART_COMMAND,
  FOCUS_PREVIOUS_PART_COMMAND,
  focusAdjacentPart,
} from '@/shell/focus-parts';
import { setDockApi } from '@/shell/dock/dock-api-ref';
import { isMainWindowDockEmpty, trackGroupMru } from '@/shell/dock/group-mru';
import { openFakePopout } from '../dock-terminal-vscode-focus/dock-fixtures';
import { terminalYieldedCommandId } from '@/panels/Terminal/terminal-hotkeys';
import { useCommandHotkeys } from '@/plugins/command-palette/useCommandHotkeys';
import { CommandRegistry } from '@/plugins/registries/CommandRegistry';
import { coApp } from '@/plugins/co-app';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

afterEach(() => {
  setDockApi(null);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('命令注册', () => {
  beforeEach(() => bootCorePlugins());
  afterEach(() => shutdownCorePlugins());

  it('focusNextPart = F6、focusPreviousPart = ⇧F6,分类「查看」,三语标题', () => {
    expect(FOCUS_NEXT_PART_COMMAND).toEqual({ id: 'workbench.action.focusNextPart', hotkey: 'f6' });
    expect(FOCUS_PREVIOUS_PART_COMMAND).toEqual({ id: 'workbench.action.focusPreviousPart', hotkey: 'shift+f6' });
    for (const { id, hotkey } of [FOCUS_NEXT_PART_COMMAND, FOCUS_PREVIOUS_PART_COMMAND]) {
      const spec = coApp.commands.get(id);
      expect(spec?.hotkey).toBe(hotkey);
      expect(spec?.categoryKey).toBe('commands.view.category');
      for (const catalog of [en, zh, ko] as ReadonlyArray<Record<string, string>>) {
        expect(catalog[spec!.titleKey!]).toBeTruthy();
      }
    }
  });
});

/**
 * 工作台骨架:dock(活动面板内容里一个可编辑区)、状态栏(按钮)、侧栏(Explorer 树,当前项 tabindex=0)。
 * 活动面板经 dock api 取(同 focusPanelContent)。
 */
function workbench(opts: { sidebarHidden?: boolean } = {}) {
  document.body.innerHTML = `
    <aside data-workbench-part="sidebar" ${opts.sidebarHidden ? 'hidden' : ''}>
      <button data-x="sidebar-header">new file</button>
      <div role="tree">
        <div role="treeitem" tabindex="-1" data-x="row-a">a</div>
        <div role="treeitem" tabindex="0" data-x="row-b">b</div>
      </div>
    </aside>
    <div data-workbench-part="dock"><div data-x="panel-content"><textarea data-x="editor"></textarea></div></div>
    <footer data-workbench-part="statusbar"><span>ws</span><button data-x="status-mcp">MCP</button></footer>
    <button data-x="outside">outside</button>`;
  const element = document.querySelector<HTMLElement>('[data-x="panel-content"]')!;
  const panel: Record<string, unknown> = { id: 'editor', view: { content: { element } } };
  panel.api = { id: 'editor', location: { type: 'grid' }, group: { panels: [panel] } };
  setDockApi({ activePanel: panel } as unknown as DockviewApi);
}
const el = (x: string) => document.querySelector<HTMLElement>(`[data-x="${x}"]`)!;

describe('F6 / ⇧F6 区域循环', () => {
  it('dock → 状态栏 → 侧栏(树当前项)→ dock', () => {
    workbench();
    el('editor').focus();
    focusAdjacentPart(1);
    expect(document.activeElement).toBe(el('status-mcp'));
    focusAdjacentPart(1);
    expect(document.activeElement).toBe(el('row-b'));
    focusAdjacentPart(1);
    expect(document.activeElement).toBe(el('editor'));
  });

  it('⇧F6 反向:dock → 侧栏 → 状态栏 → dock', () => {
    workbench();
    el('editor').focus();
    focusAdjacentPart(-1);
    expect(document.activeElement).toBe(el('row-b'));
    focusAdjacentPart(-1);
    expect(document.activeElement).toBe(el('status-mcp'));
    focusAdjacentPart(-1);
    expect(document.activeElement).toBe(el('editor'));
  });

  it('侧栏隐藏 → 跳过', () => {
    workbench({ sidebarHidden: true });
    el('status-mcp').focus();
    focusAdjacentPart(1);
    expect(document.activeElement).toBe(el('editor'));
  });

  it('焦点不在任何区域(body / 区域外)→ F6 / ⇧F6 都先到活动 dock 组', () => {
    workbench();
    el('outside').focus();
    focusAdjacentPart(1);
    expect(document.activeElement).toBe(el('editor'));
    el('outside').focus();
    focusAdjacentPart(-1);
    expect(document.activeElement).toBe(el('editor'));
  });

  it('没有活动面板 → dock 跳过', () => {
    workbench();
    setDockApi({ activePanel: undefined } as unknown as DockviewApi);
    el('row-b').focus();
    focusAdjacentPart(1);
    expect(document.activeElement).toBe(el('status-mcp'));
  });
});

/** 真实 dockview 挂在 dock 区域里:a | b | c 三组,每个面板内容里一个 textarea(data-x=editor-<id>)。 */
function realDockWorkbench() {
  workbench();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const dockPart = document.querySelector<HTMLElement>('[data-workbench-part="dock"]')!;
  dockPart.innerHTML = '';
  const container = document.createElement('div');
  dockPart.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: ({ id }) => {
      const element = document.createElement('div');
      element.innerHTML = `<textarea data-x="editor-${id}"></textarea>`;
      return { element, init: () => {} };
    },
  });
  const api = dock.api as DockviewApi;
  api.addPanel({ id: 'a', component: 'x', title: 'a' });
  api.addPanel({ id: 'b', component: 'x', title: 'b', position: { referencePanel: 'a', direction: 'right' } });
  api.addPanel({ id: 'c', component: 'x', title: 'c', position: { referencePanel: 'b', direction: 'right' } });
  setDockApi(api);
  return { dock, api, tracker: trackGroupMru(api) };
}

describe('活动面板在 popout 子窗时的主窗 F6', () => {
  it('主窗 F6 不跳过 dock:激活并聚焦主窗最近使用的组的活动面板(VSCode:主窗 F6 只在主窗自己的区域循环)', async () => {
    const { dock, api, tracker } = realDockWorkbench();
    // 主窗 MRU:b 比 a 近(groups 顺序里 a 在前,用 b 区分「按 MRU」与「取第一个组」)。
    api.getPanel('a')!.api.setActive();
    api.getPanel('b')!.api.setActive();
    await openFakePopout(dock, 'c');
    api.getPanel('c')!.api.setActive();
    expect(api.activePanel?.api.location.type).toBe('popout');
    el('row-b').focus();

    focusAdjacentPart(1);

    expect(api.activePanel?.id).toBe('b');
    expect(document.activeElement).toBe(el('editor-b'));
    tracker.dispose();
  });
});

describe('空编辑器组 / 主窗无面板(VSCode:F6 落到空编辑器组,不跳过编辑区)', () => {
  it('活动面板内容里只有 tabIndex=-1 的编辑器面板根(关光 tab 的空编辑器)→ F6 聚焦面板根', () => {
    workbench();
    el('panel-content').innerHTML =
      '<div data-editor-panel-root="" tabindex="-1" data-x="editor-root"><p>welcome</p></div>';
    el('row-b').focus();
    focusAdjacentPart(1);
    expect(document.activeElement).toBe(el('editor-root'));
  });

  it('面板内容根本身是 tabIndex=-1 的根元素(非编辑器)→ 同样回退聚焦它', () => {
    workbench();
    el('panel-content').innerHTML = '<div tabindex="-1" data-x="plain-root"><span tabindex="-1">x</span></div>';
    el('row-b').focus();
    focusAdjacentPart(1);
    expect(document.activeElement).toBe(el('plain-root'));
  });

  it('没有可聚焦面板但 dock 区域显示空态(data-dock-empty,tabIndex=-1)→ F6 聚焦空态容器', () => {
    workbench();
    setDockApi({ activePanel: undefined } as unknown as DockviewApi);
    document
      .querySelector('[data-workbench-part="dock"]')!
      .insertAdjacentHTML('beforeend', '<div data-dock-empty="" tabindex="-1" data-x="dock-empty"></div>');
    el('row-b').focus();
    focusAdjacentPart(1);
    expect(document.activeElement).toBe(el('dock-empty'));
  });

  it('所有组都弹出到子窗:主窗 dock 判空(isMainWindowDockEmpty),主窗 F6 聚焦空态容器', async () => {
    const { dock, api, tracker } = realDockWorkbench();
    for (const id of ['a', 'b', 'c']) await openFakePopout(dock, id);
    expect(api.totalPanels).toBe(3);
    expect(isMainWindowDockEmpty(api)).toBe(true);
    document
      .querySelector('[data-workbench-part="dock"]')!
      .insertAdjacentHTML('beforeend', '<div data-dock-empty="" tabindex="-1" data-x="dock-empty"></div>');
    el('row-b').focus();

    focusAdjacentPart(1);

    expect(document.activeElement).toBe(el('dock-empty'));
    tracker.dispose();
  });

  it('主窗还有面板 → 不判空', () => {
    const { api, tracker } = realDockWorkbench();
    expect(isMainWindowDockEmpty(api)).toBe(false);
    tracker.dispose();
  });
});

describe('终端与编辑器里的 F6', () => {
  const noRegistry = { getAll: () => [] };

  it('终端让出 F6 / ⇧F6 给命令(VSCode commandsToSkipShell 默认包含)', () => {
    expect(terminalYieldedCommandId(key({ key: 'F6' }), 'mac', {}, noRegistry)).toBe(FOCUS_NEXT_PART_COMMAND.id);
    expect(terminalYieldedCommandId(key({ key: 'F6', shiftKey: true }), 'other', {}, noRegistry)).toBe(
      FOCUS_PREVIOUS_PART_COMMAND.id,
    );
  });

  it('解绑 / 改绑到别的键 → 终端不再让出 F6', () => {
    expect(terminalYieldedCommandId(key({ key: 'F6' }), 'mac', { [FOCUS_NEXT_PART_COMMAND.id]: '' }, noRegistry)).toBeNull();
  });

  it('可编辑控件(编辑器 / 输入框)里 F6 照常触发命令;单字母绑定仍放行给打字', () => {
    const f6 = vi.fn();
    const x = vi.fn();
    const reg = new CommandRegistry();
    reg.register({ id: FOCUS_NEXT_PART_COMMAND.id, title: 'next', hotkey: 'f6', fn: f6 });
    reg.register({ id: 'x', title: 'x', hotkey: 'x', fn: x });
    renderHook(() => useCommandHotkeys(reg));
    // jsdom 不实现 isContentEditable,用 textarea 代表可编辑目标(同一 A64 判定分支)
    const content = document.createElement('textarea');
    document.body.appendChild(content);

    const event = key({ key: 'F6' });
    content.dispatchEvent(event);
    content.dispatchEvent(key({ key: 'x' }));

    expect(f6).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(x).not.toHaveBeenCalled();
  });
});
