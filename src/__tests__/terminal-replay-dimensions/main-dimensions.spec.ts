// BDD: terminal-replay-dimensions / 主进程记录 PTY 尺寸变化,快照带回放分段尺寸。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWindow } from '../migration-step1-pty-handover/fixtures';

const sm = vi.hoisted(() => ({
  options: undefined as { onData?: (sessionId: string, chunk: string) => void } | undefined,
  create: vi.fn(),
  resize: vi.fn(),
  data: '',
}));

vi.mock('@continuo-terminal/server-node', async () => ({
  ...(await vi.importActual<typeof import('@continuo-terminal/server-node')>('@continuo-terminal/server-node')),
  SessionManager: vi.fn().mockImplementation((options) => {
    sm.options = options;
    return {
      create: sm.create,
      resize: sm.resize,
      getBufferSnapshot: () => ({ data: sm.data, nextSeq: 1, truncated: false }),
      kill: vi.fn(async () => ({})),
    };
  }),
  prepareShellIntegrationEnv: vi.fn(async (_shell: string, env: Record<string, string>) => ({
    env,
    cleanup: async () => {},
  })),
}));
vi.mock('electron', () => ({
  app: { getPath: vi.fn((key: string) => `/tmp/test-${key}`) },
  BrowserWindow: {},
}));
vi.mock('../../../electron/main/services/settings.service', () => ({ getCurrentLocale: vi.fn(() => 'en') }));
vi.mock('../../../electron/main/services/pty-lang', () => ({ withPtyLangEnv: vi.fn((env) => env) }));

import * as terminalService from '../../../electron/main/services/terminal.service';
import * as terminalSessions from '../../../electron/main/services/terminal-sessions.service';

/** PTY 输出:同时进 ring buffer(快照数据)与主进程计数。 */
const emit = (chunk: string) => {
  sm.data += chunk;
  sm.options?.onData?.('a', chunk);
};
const dims = () => terminalService.getBufferSnapshot('a').dimensions;

describe('terminal replay dimensions · 主进程', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    terminalService.__resetForTest();
    terminalSessions._reset();
    sm.data = '';
    sm.create.mockReset().mockResolvedValue({ session_id: 'a' });
    sm.resize.mockReset().mockResolvedValue({});
    await terminalService.createTerminal('a', makeWindow(1), '/bin/zsh', [], '/tmp');
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('初始尺寸 120×40 在偏移 0', () => {
    emit('abc');
    expect(dims()).toEqual([{ offset: 0, cols: 120, rows: 40 }]);
  });

  it('resize 成功 → 在当时的累计偏移处记新尺寸;尺寸没变不记', async () => {
    emit('abcd');
    await terminalService.resize('a', 80, 24);
    await terminalService.resize('a', 80, 24);
    emit('ef');
    expect(dims()).toEqual([
      { offset: 0, cols: 120, rows: 40 },
      { offset: 4, cols: 80, rows: 24 },
    ]);
  });

  it('同一偏移上的连续 resize 只留最后一次;改回原尺寸则合并掉', async () => {
    await terminalService.resize('a', 80, 24);
    await terminalService.resize('a', 100, 30);
    emit('xy');
    expect(dims()).toEqual([{ offset: 0, cols: 100, rows: 30 }]);
    await terminalService.resize('a', 90, 30);
    await terminalService.resize('a', 100, 30);
    emit('z');
    expect(dims()).toEqual([{ offset: 0, cols: 100, rows: 30 }]);
  });

  it('resize 失败不记', async () => {
    emit('ab');
    sm.resize.mockRejectedValueOnce(new Error('EIO'));
    await terminalService.resize('a', 80, 24);
    expect(dims()).toEqual([{ offset: 0, cols: 120, rows: 40 }]);
  });

  it('快照开头已被挤掉 → 起点之前的最后一条作为开头那段(偏移夹到 startOffset)', async () => {
    emit('0123');
    await terminalService.resize('a', 80, 24);
    emit('4567');
    await terminalService.resize('a', 60, 20);
    emit('89');
    sm.data = '6789'; // ring buffer 只剩 [6,10)
    expect(dims()).toEqual([
      { offset: 6, cols: 80, rows: 24 },
      { offset: 8, cols: 60, rows: 20 },
    ]);
  });

  it('记录条数有上限,超出丢最旧的(开头那段沿用剩下的第一条)', async () => {
    for (let i = 0; i < terminalService.TERMINAL_DIMENSIONS_MAX + 5; i++) {
      emit('x');
      await terminalService.resize('a', 50 + (i % 2), 20);
    }
    const list = dims()!;
    expect(list.length).toBeLessThanOrEqual(terminalService.TERMINAL_DIMENSIONS_MAX);
    expect(list[0]!.offset).toBe(0);
  });
});
