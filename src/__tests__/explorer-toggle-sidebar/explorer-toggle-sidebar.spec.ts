// @vitest-environment jsdom
// BDD: explorer-toggle-sidebar
// 验证 ExplorerTabPlugin 注册 explorer.toggleSidebar 命令(hotkey=mod+b)
// 且 fn 切换 useLayoutUiStore.sidebarOpen。
//
// 实装在 ExplorerTabPlugin onload。该 plugin 已注册 explorer settings tab,
// 本 spec 只校验新增的命令贡献 — 不重复测既有 settings 行为。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { bootCorePlugins, shutdownCorePlugins } from '../../core-plugins';
import { coApp } from '../../plugins/co-app';
import { useLayoutUiStore } from '../../stores/layout-ui.store';
import { setDockApi } from '../../shell/dock/dock-api-ref';

beforeEach(async () => {
  await shutdownCorePlugins();
  useLayoutUiStore.setState({ sidebarOpen: true });
});

afterEach(async () => {
  await shutdownCorePlugins();
});

describe('explorer.toggleSidebar · 命令注册', () => {
  it('boot 后 commands registry 含 explorer.toggleSidebar', () => {
    bootCorePlugins();
    const ids = coApp.commands.getAll().map((c) => c.id);
    expect(ids).toContain('explorer.toggleSidebar');
  });

  it('hotkey 默认 mod+b', () => {
    bootCorePlugins();
    const cmd = coApp.commands
      .getAll()
      .find((c) => c.id === 'explorer.toggleSidebar')!;
    expect(cmd.hotkey).toBe('mod+b');
  });

  it('category 为 Explorer + title 含「Explorer」+ titleKey 指向 i18n', () => {
    bootCorePlugins();
    const cmd = coApp.commands
      .getAll()
      .find((c) => c.id === 'explorer.toggleSidebar')!;
    expect(cmd.category).toBe('Explorer');
    // topic-19: title 是 ASCII fallback；titleKey 指 i18n catalog 命中 zh = '切换资源管理器侧栏'
    expect(cmd.title).toContain('Explorer');
    expect(cmd.titleKey).toBe('settings.explorer.toggle_sidebar');
  });

  it('shutdown 后命令移除', async () => {
    bootCorePlugins();
    await shutdownCorePlugins();
    const ids = coApp.commands.getAll().map((c) => c.id);
    expect(ids).not.toContain('explorer.toggleSidebar');
  });
});

describe('explorer.toggleSidebar · fn 行为', () => {
  it('调 fn → sidebarOpen 由 true 切到 false', async () => {
    bootCorePlugins();
    const cmd = coApp.commands
      .getAll()
      .find((c) => c.id === 'explorer.toggleSidebar')!;
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
    await cmd.fn();
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(false);
  });

  it('再调 fn → 切回 true(toggle 可重复)', async () => {
    bootCorePlugins();
    const cmd = coApp.commands
      .getAll()
      .find((c) => c.id === 'explorer.toggleSidebar')!;
    await cmd.fn();
    await cmd.fn();
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
  });
});

// VSCode:隐藏含焦点的侧栏(⌘B)→ 焦点移到活动编辑器 / 面板,不落 body;侧栏外的焦点不动;显示侧栏不抢焦点。
describe('explorer.toggleSidebar · 焦点', () => {
  afterEach(() => {
    setDockApi(null);
    document.body.innerHTML = '';
  });

  /** 侧栏(Explorer 树)+ dock(活动面板内容里一个编辑区)+ 状态栏按钮;活动面板经 dock api 取。 */
  function workbench() {
    document.body.innerHTML = `
      <aside data-workbench-part="sidebar">
        <div role="tree"><div role="treeitem" tabindex="0" data-x="row">a</div></div>
      </aside>
      <div data-workbench-part="dock"><div data-x="panel-content"><textarea data-x="editor"></textarea></div></div>
      <footer data-workbench-part="statusbar"><button data-x="status">MCP</button></footer>`;
    const element = document.querySelector<HTMLElement>('[data-x="panel-content"]')!;
    const panel: Record<string, unknown> = { id: 'editor', view: { content: { element } } };
    panel.api = { id: 'editor', location: { type: 'grid' }, group: { panels: [panel] } };
    setDockApi({ activePanel: panel } as unknown as DockviewApi);
  }
  const el = (x: string) => document.querySelector<HTMLElement>(`[data-x="${x}"]`)!;
  const toggle = async () => {
    await coApp.commands.getAll().find((c) => c.id === 'explorer.toggleSidebar')!.fn();
  };

  it('焦点在资源管理器树里 → 隐藏侧栏后焦点交给活动面板的编辑区(不落 body);再显示焦点仍在编辑区', async () => {
    bootCorePlugins();
    workbench();
    el('row').focus();
    await toggle();
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(false);
    expect(document.activeElement).toBe(el('editor'));
    await toggle();
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(true);
    expect(document.activeElement).toBe(el('editor'));
  });

  it('焦点不在侧栏里(状态栏按钮)→ 隐藏侧栏不移动焦点', async () => {
    bootCorePlugins();
    workbench();
    el('status').focus();
    await toggle();
    expect(useLayoutUiStore.getState().sidebarOpen).toBe(false);
    expect(document.activeElement).toBe(el('status'));
  });
});
