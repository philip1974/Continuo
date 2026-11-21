import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionManagerMock = vi.hoisted(() => ({
  getBufferSnapshot: vi.fn(),
  readOutput: vi.fn(),
}));

vi.mock('@continuo-terminal/server-node', () => ({
  SessionManager: vi.fn().mockImplementation(() => sessionManagerMock),
}));

import * as service from '../../../electron/main/services/terminal.service';

describe('migration step2 buffer merge · replay completeness', () => {
  beforeEach(() => {
    service.__resetForTest();
    sessionManagerMock.getBufferSnapshot.mockReset();
    sessionManagerMock.readOutput.mockReset();
  });

  it('T1 returns raw ANSI bytes for renderer replay', () => {
    sessionManagerMock.getBufferSnapshot.mockReturnValue({
      data: 'abc\x1b[31mred\x1b[0m\n',
      nextSeq: 2,
      truncated: false,
    });

    expect(service.getBufferSnapshot('term-1')).toEqual({
      data: 'abc\x1b[31mred\x1b[0m\n',
      truncated: false,
    });
  });

  it('T2 preserves cross-chunk ANSI after SessionManager concatenation', () => {
    sessionManagerMock.getBufferSnapshot.mockReturnValue({
      data: '\x1b[31mred\x1b[0m',
      nextSeq: 3,
      truncated: false,
    });

    expect(service.getBufferSnapshot('term-ansi')).toEqual({
      data: '\x1b[31mred\x1b[0m',
      truncated: false,
    });
  });

  it('T3 prefixes reset escape when snapshot is truncated', () => {
    sessionManagerMock.getBufferSnapshot.mockReturnValue({
      data: 'tail',
      nextSeq: 4,
      truncated: true,
    });

    expect(service.getBufferSnapshot('term-truncated')).toEqual({
      data: '\x1b[0mtail',
      truncated: true,
    });
  });
});
