// topic-19 P0-4: 验证 12 个 core-plugins 注册的 CommandSpec / PanelSpec
// titleKey 命中 i18n catalog（避免 hardcode 漏迁）.

import { describe, expect, it } from 'vitest';
import { bootCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { en } from '@shared/i18n-locales/en';

const CATALOG_KEYS = new Set(Object.keys(en));

describe('topic-19 core-plugins titleKey hits catalog', () => {
  it('每个含 titleKey 的 CommandSpec 在 catalog 内', () => {
    bootCorePlugins();
    const violations: string[] = [];
    for (const cmd of coApp.commands.getAll()) {
      if (cmd.titleKey && !CATALOG_KEYS.has(cmd.titleKey)) {
        violations.push(`command.${cmd.id}.titleKey=${cmd.titleKey}`);
      }
      if (cmd.categoryKey && !CATALOG_KEYS.has(cmd.categoryKey)) {
        violations.push(`command.${cmd.id}.categoryKey=${cmd.categoryKey}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('每个含 titleKey 的 PanelSpec 在 catalog 内', () => {
    bootCorePlugins();
    const violations: string[] = [];
    for (const p of coApp.panels.getAll()) {
      if (p.titleKey && !CATALOG_KEYS.has(p.titleKey)) {
        violations.push(`panel.${p.type}.titleKey=${p.titleKey}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('关键 core-plugins 都已扩 titleKey（不只是 ASCII fallback）', () => {
    bootCorePlugins();
    const findCmd = (id: string) =>
      coApp.commands.getAll().find((c) => c.id === id);
    const findPanel = (type: string) =>
      coApp.panels.getAll().find((p) => p.type === type);

    expect(findCmd('terminal.new')?.titleKey).toBe('commands.terminal.new.title');
    expect(findCmd('window.new')?.titleKey).toBe('commands.window.new.title');
    expect(findCmd('window.openFolderInNew')?.titleKey).toBe(
      'commands.window.open_folder.title',
    );
    expect(findCmd('settings.toggle')?.titleKey).toBe(
      'commands.settings.toggle.title',
    );
    expect(findCmd('explorer.toggleSidebar')?.titleKey).toBe(
      'settings.explorer.toggle_sidebar',
    );

    expect(findPanel('terminal')?.titleKey).toBe('panels.terminal.title');
    expect(findPanel('editor')?.titleKey).toBe('panels.editor.title');
    expect(findPanel('output')?.titleKey).toBe('panels.output.title');
    expect(findPanel('settings')?.titleKey).toBe('panels.settings.title');
  });
});
