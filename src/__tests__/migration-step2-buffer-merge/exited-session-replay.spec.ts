import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionManagerMock = vi.hoisted(() => ({
  getBufferSnapshot: vi.fn(),
  readOutput: vi.fn(),
}));

vi.mock('@continuo-terminal/server-node', () => ({
  SessionManager: vi.fn().mockImplementation(() => sessionManagerMock),
}));

import * as service from '../../../electron/main/services/terminal.service';

function sessionNotFound(): Error & { code: string } {
  const err = new Error('Session not found: exited-id') as Error & { code: string };
  err.code = 'SESSION_NOT_FOUND';
  return err;
}

describe('migration step2 buffer merge · exited session replay', () => {
  beforeEach(() => {
    service.__resetForTest();
    sessionManagerMock.getBufferSnapshot.mockReset();
    sessionManagerMock.readOutput.mockReset();
  });

  it('T6a getBufferSnapshot returns empty for exited session', () => {
    sessionManagerMock.getBufferSnapshot.mockImplementation(() => {
      throw sessionNotFound();
    });

    expect(service.getBufferSnapshot('exited-id')).toEqual({
      data: '',
      truncated: false,
    });
  });

  it('T6b readOutput throws TERMINAL_SESSION_NOT_FOUND for exited session', async () => {
    const original = sessionNotFound();
    sessionManagerMock.readOutput.mockRejectedValue(original);

    await expect(service.readOutput('exited-id', {})).rejects.toMatchObject({
      code: 'TERMINAL_SESSION_NOT_FOUND',
      cause: original,
    });
  });
});
