// @vitest-environment jsdom
// BDD: explorer-toggle-sidebar
// 验证 ExplorerTabPlugin 注册 explorer.toggleSidebar 命令(hotkey=mod+b)
// 且 fn 切换 useLayoutUiStore.sidebarOpen。
//
// 实装在 ExplorerTabPlugin onload。该 plugin 已注册 explorer settings tab,
// 本 spec 只校验新增的命令贡献 — 不重复测既有 settings 行为。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootCorePlugins, shutdownCorePlugins } from '../../core-plugins';
import { coApp } from '../../plugins/co-app';
import { useLayoutUiStore } from '../../stores/layout-ui.store';

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
    // topic-19: title 是 ASCII fallback；titleKey 指 i18n catalog 命中 zh = '切换 Explorer 侧栏'
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
