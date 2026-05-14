import { describe, expect, it, vi } from 'vitest';
import { makeCreateHandler } from '../../../electron/main/ipc/terminal.ipc';

describe('terminal pane internal split - cwd fallback in IPC resolve', () => {
  it('passes resolved cwd to service and stores the same cwd in metadata', async () => {
    const createTerminal = vi.fn().mockResolvedValue(undefined);
    const add = vi.fn();
    const handler = makeCreateHandler({
      generateId: () => 'term-1',
      resolveCwd: () => '/resolved',
      service: { createTerminal } as never,
      sessionStore: {
        add,
        nextDefaultTitle: () => 'Terminal 1',
      } as never,
    });

    const result = await handler({ cwd: '/deleted', scoped: true }, { id: 11 } as never);

    expect(result).toEqual({ id: 'term-1', cwd: '/resolved', title: 'Terminal 1' });
    expect(createTerminal).toHaveBeenCalledWith(
      'term-1',
      expect.objectContaining({ id: 11 }),
      expect.any(String),
      [],
      '/resolved',
      expect.any(Object),
      expect.any(Object),
    );
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/resolved' }));
  });
});
