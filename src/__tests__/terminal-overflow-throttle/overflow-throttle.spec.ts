import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWindow } from '../migration-step1-pty-handover/fixtures';

const sessionManagerMock = vi.hoisted(() => ({
  options: undefined as
    | { onData?: (sessionId: string, chunk: string) => void }
    | undefined,
  create: vi.fn(),
}));

vi.mock('@continuo-terminal/server-node', async () => ({
  ...(await vi.importActual<typeof import('@continuo-terminal/server-node')>(
    '@continuo-terminal/server-node',
  )),
  SessionManager: vi.fn().mockImplementation((options) => {
    sessionManagerMock.options = options;
    return { create: sessionManagerMock.create, kill: vi.fn(async () => ({})) };
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
vi.mock('../../../electron/main/services/settings.service', () => ({
  getCurrentLocale: vi.fn(() => 'en'),
}));
vi.mock('../../../electron/main/services/pty-lang', () => ({
  withPtyLangEnv: vi.fn((env) => env),
}));

import * as terminalService from '../../../electron/main/services/terminal.service';
import * as terminalSessions from '../../../electron/main/services/terminal-sessions.service';

const MiB = 1024 * 1024;

function emit(chunk: string): void {
  sessionManagerMock.options?.onData?.('a', chunk);
}

const TRUNCATE_MAX = 64 * 1024;
const RESET_PREFIX = '\x1b[0m';

/** 已推给 renderer 的输出批次(terminal:data 的 data 参数)。 */
function dataBatches(win: ReturnType<typeof makeWindow>): string[] {
  return (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => c[0] === 'terminal:data')
    .map((c) => c[2] as string);
}

function lastBatch(win: ReturnType<typeof makeWindow>): string {
  const batches = dataBatches(win);
  return batches[batches.length - 1]!;
}

/** 该批是否经 overflow 截断(只留尾部并加 reset 前缀)。 */
function isTruncated(batch: string): boolean {
  return batch.startsWith(RESET_PREFIX) && batch.length <= TRUNCATE_MAX;
}

describe('terminal overflow 节流 · 吞吐窗口与截断', () => {
  let win: ReturnType<typeof makeWindow>;

  beforeEach(async () => {
    // 吞吐窗口用单调时钟(performance.now),须一并 fake(vitest 默认不 fake performance)。
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'Date',
        'performance',
      ],
    });
    vi.setSystemTime(0);
    terminalService.__resetForTest();
    terminalSessions._reset();
    sessionManagerMock.create.mockReset().mockResolvedValue({ session_id: 'a' });
    win = makeWindow(1);
    await terminalService.createTerminal('a', win, '/bin/zsh', [], '/tmp');
  });

  afterEach(() => {
    terminalService.forceKill('a');
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // perf:此前每个 PTY 一个永久 1Hz setInterval(上限 256 会话 → 空闲时 256 次/秒唤醒主进程)。
  it('空闲终端不持有任何周期定时器', () => {
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('普通输出合批发送后不残留定时器', () => {
    emit('hello');
    vi.advanceTimersByTime(5);
    expect(dataBatches(win)).toEqual(['hello']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('1s 窗口以创建时刻对齐:跨窗口边界的两段各 <2MiB 不截断', () => {
    vi.advanceTimersByTime(900);
    emit('x'.repeat(1.5 * MiB));
    vi.advanceTimersByTime(200); // t=1100,进入下一窗口
    emit('x'.repeat(1 * MiB));
    vi.advanceTimersByTime(500);
    expect(dataBatches(win).map((b) => b.length)).toEqual([1.5 * MiB, 1 * MiB]);
  });

  it('同一窗口内累计 >2MiB → 截断到 64KiB + 100ms 合批', () => {
    vi.advanceTimersByTime(100);
    emit('x'.repeat(1.5 * MiB));
    vi.advanceTimersByTime(800); // t=900,同一窗口
    emit('x'.repeat(1 * MiB));
    vi.advanceTimersByTime(99);
    expect(dataBatches(win)).toHaveLength(1); // overflow 批次尚未到 100ms
    vi.advanceTimersByTime(1);
    expect(dataBatches(win)).toHaveLength(2);
    expect(isTruncated(lastBatch(win))).toBe(true);
  });

  it('overflow 后流静默 → flush 完不残留任何定时器', () => {
    emit('x'.repeat(3 * MiB)); // t=0 进入 overflow
    vi.advanceTimersByTime(100);
    expect(isTruncated(lastBatch(win))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('overflow 后下一窗口来低速输出 → 不截断,按普通 5ms 合批', () => {
    emit('x'.repeat(3 * MiB));
    vi.advanceTimersByTime(1200);
    emit('ok');
    vi.advanceTimersByTime(5);
    expect(lastBatch(win)).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('下一窗口仍持续高速 → 继续截断', () => {
    emit('x'.repeat(3 * MiB));
    vi.advanceTimersByTime(1500);
    emit('x'.repeat(3 * MiB)); // 新窗口单 chunk 即超阈值
    vi.advanceTimersByTime(100);
    expect(dataBatches(win)).toHaveLength(2);
    expect(dataBatches(win).every(isTruncated)).toBe(true);
  });

  // 吞吐窗口用单调时钟:系统时间回拨不得让窗口长期不滚动(否则回拨后的输出一直按 overflow 截断)。
  it('overflow 后系统时间回拨 1 小时 → 下一窗口照常滚动,输出不截断', () => {
    emit('x'.repeat(3 * MiB));
    vi.setSystemTime(-3_600_000);
    vi.advanceTimersByTime(1100);
    emit('ok');
    vi.advanceTimersByTime(5);
    expect(lastBatch(win)).toBe('ok');
  });

  it('overflow 批次在途时会话被清理 → 定时器一并清除', () => {
    emit('x'.repeat(3 * MiB));
    expect(vi.getTimerCount()).toBe(1); // 100ms overflow flush 在途
    terminalService.forceKill('a');
    expect(vi.getTimerCount()).toBe(0);
  });
});
