import { describe, expect, it } from 'vitest';

describe('tab split panes - persistence', () => {
  it('serializes terminal split pane params without volatile sessionId', async () => {
    const mod = (await import('../../shell/dock/DockShell')) as {
      sanitizePersistedDockLayout?: (layout: unknown) => unknown;
    };
    const sanitize = mod.sanitizePersistedDockLayout;

    expect(sanitize).toEqual(expect.any(Function));
    const layout = {
      panels: {
        'terminal-term-1': {
          contentComponent: 'terminal',
          params: { sessionId: 'term-1', cwd: '/repo', title: 'Split', role: 'split' },
        },
      },
    };

    expect(sanitize?.(layout)).toEqual({
      panels: {
        'terminal-term-1': {
          contentComponent: 'terminal',
          params: { cwd: '/repo', title: 'Split', role: 'split' },
        },
      },
    });
  });
});
