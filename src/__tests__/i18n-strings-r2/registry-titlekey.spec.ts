import { describe, expect, it } from 'vitest';
import { CommandRegistry, type CommandSpec } from '@/plugins/registries/CommandRegistry';
import { PanelRegistry, type PanelSpec } from '@/plugins/registries/PanelRegistry';
import type { TranslationKey } from '@/i18n';

describe('topic-19 registry titleKey/categoryKey fields', () => {
  it('CommandSpec accepts titleKey + categoryKey (typed string)', () => {
    const spec: CommandSpec = {
      id: 'test.cmd',
      title: 'Test Command',
      titleKey: 'commands.terminal.new.title',
      category: 'Terminal',
      categoryKey: 'commands.terminal.category',
      fn: () => undefined,
    };
    const reg = new CommandRegistry();
    reg.register(spec);
    const got = reg.getAll().find((c) => c.id === 'test.cmd');
    expect(got?.titleKey).toBe('commands.terminal.new.title');
    expect(got?.categoryKey).toBe('commands.terminal.category');
  });

  it('CommandSpec.titleKey is optional (backwards-compat)', () => {
    const spec: CommandSpec = {
      id: 'legacy.cmd',
      title: 'Legacy',
      fn: () => undefined,
    };
    const reg = new CommandRegistry();
    reg.register(spec);
    expect(reg.getAll().find((c) => c.id === 'legacy.cmd')?.titleKey).toBeUndefined();
  });

  it('PanelSpec accepts titleKey', () => {
    const spec: PanelSpec = {
      type: 'test.panel',
      factory: () => null,
      title: 'Test Panel',
      titleKey: 'panels.terminal.title',
    };
    const reg = new PanelRegistry();
    reg.register(spec);
    expect(reg.getAll().find((p) => p.type === 'test.panel')?.titleKey).toBe(
      'panels.terminal.title',
    );
  });

  it('core plugin can use satisfies TranslationKey for compile-time catalog validation', () => {
    // type-level demo: 'common.cancel' 是 topic-16 已落地 key，satisfies 编译期验完整性
    const key = 'common.cancel' satisfies TranslationKey;
    expect(typeof key).toBe('string');
  });
});
