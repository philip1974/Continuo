import { beforeEach, describe, expect, it } from 'vitest';
import * as sessions from '../../../electron/main/services/terminal-sessions.service';

describe('tab split panes - terminal create scoped schema', () => {
  beforeEach(() => {
    sessions._reset();
  });

  it('stores scoped=true in terminal session metadata for split-created terminals', () => {
    sessions.add({
      id: 'term-scoped',
      title: 'Scoped',
      cwd: '/repo',
      originHint: 'user',
      ownerWindowId: 1,
      scoped: true,
    } as Parameters<typeof sessions.add>[0] & { scoped: true });

    expect(sessions.get('term-scoped')).toEqual(
      expect.objectContaining({
        id: 'term-scoped',
        scoped: true,
      }),
    );
  });
});
