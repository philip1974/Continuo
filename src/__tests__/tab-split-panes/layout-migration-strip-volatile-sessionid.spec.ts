import { describe, expect, it } from 'vitest';

describe('tab split panes - layout migration strips volatile sessionId', () => {
  it('strips sessionId from persisted terminal panel params before Dockview fromJSON', async () => {
    const mod = (await import('../../shell/dock/DockShell')) as {
      sanitizePersistedDockLayout?: (layout: unknown) => unknown;
    };
    const sanitize = mod.sanitizePersistedDockLayout;
    const oldLayout = {
      grid: { root: 'stub' },
      panels: {
        'terminal-dead-id': {
          contentComponent: 'terminal',
          params: {
            sessionId: 'dead-id',
            cwd: '/repo',
            title: 'Restored Split',
            role: 'split',
          },
        },
        editor: {
          contentComponent: 'editor',
          params: { sessionId: 'editor-state-is-not-terminal' },
        },
      },
    };

    expect(sanitize).toEqual(expect.any(Function));
    const migrated = sanitize?.(oldLayout) as typeof oldLayout;

    expect(migrated.panels['terminal-dead-id'].params).toEqual({
      cwd: '/repo',
      title: 'Restored Split',
      role: 'split',
    });
    expect(migrated.panels.editor.params).toEqual({
      sessionId: 'editor-state-is-not-terminal',
    });
  });
});
