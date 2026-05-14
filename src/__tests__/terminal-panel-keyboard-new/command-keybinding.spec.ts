import { describe, expect, it, vi } from 'vitest';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import TerminalPanelPlugin from '@/core-plugins/TerminalPanelPlugin';

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn().mockResolvedValue({ ok: true, data: { id: 'term-new' } }),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    system: { windowId: 1 },
    terminal: {
      create: mocks.createTerminal,
    },
  },
}));

function collectTerminalCommands(): CommandSpec[] {
  const commands: CommandSpec[] = [];
  const app = {
    commands: {
      register: vi.fn((spec: CommandSpec) => {
        commands.push(spec);
        return { dispose: vi.fn() };
      }),
    },
  };
  const plugin = new TerminalPanelPlugin(app as never, {
    id: 'core.terminal-panel',
    name: 'TerminalPanel',
    version: '1.0.0',
  });
  plugin.onload();
  return commands;
}

describe('terminal.new command + keybinding', () => {
  it("注册 id='terminal.new' 的命令", () => {
    const commands = collectTerminalCommands();
    expect(commands.map((c) => c.id)).toContain('terminal.new');
  });

  it("terminal.new 默认 hotkey 是 'mod+t'", () => {
    const cmd = collectTerminalCommands().find((c) => c.id === 'terminal.new');
    expect(cmd?.hotkey).toBe('mod+t');
  });

  it('触发 terminal.new fn → coApi.terminal.create', async () => {
    const cmd = collectTerminalCommands().find((c) => c.id === 'terminal.new');
    expect(cmd).toBeDefined();

    await cmd!.fn();

    expect(mocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ originHint: 'user' }),
    );
  });
});
