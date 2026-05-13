import { describe, expect, it, vi } from 'vitest';

describe('tab split panes - hotkey no conflict', () => {
  it('registers terminal split commands without replacing existing command ids', async () => {
    const registered: Array<{ id: string; hotkey?: string }> = [];
    const mod = await import('../../core-plugins/TerminalPanelPlugin');
    const app = {
      commands: {
        register: vi.fn((cmd: { id: string; hotkey?: string }) => {
          registered.push(cmd);
          return { dispose: vi.fn() };
        }),
      },
    };
    const plugin = new mod.default(
      app as never,
      { id: 'core.terminal-panel', name: 'TerminalPanel', version: '1.0.0' },
    );

    plugin.onload();

    expect(registered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'terminal.splitRight' }),
        expect.objectContaining({ id: 'terminal.splitDown' }),
      ]),
    );
    expect(new Set(registered.map((x) => x.id)).size).toBe(registered.length);
  });
});
