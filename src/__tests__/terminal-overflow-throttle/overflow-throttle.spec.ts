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

function overflowEvents(win: ReturnType<typeof makeWindow>): string[] {
  return (win.webContents.send as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0] as string)
    .filter((ch) => ch === 'terminal:overflow' || ch === 'terminal:overflow-recovered');
}

describe('terminal overflow 节流 · 吞吐窗口与恢复', () => {
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
    expect(vi.getTimerCount()).toBe(0);
  });

  it('1s 窗口以创建时刻对齐:跨窗口边界的两段各 <2MiB 不触发 overflow', () => {
    vi.advanceTimersByTime(900);
    emit('x'.repeat(1.5 * MiB));
    vi.advanceTimersByTime(200); // t=1100,进入下一窗口
    emit('x'.repeat(1 * MiB));
    vi.advanceTimersByTime(500);
    expect(overflowEvents(win)).toEqual([]);
  });

  it('同一窗口内累计 >2MiB → overflow', () => {
    vi.advanceTimersByTime(100);
    emit('x'.repeat(1.5 * MiB));
    vi.advanceTimersByTime(800); // t=900,同一窗口
    emit('x'.repeat(1 * MiB));
    expect(overflowEvents(win)).toEqual(['terminal:overflow']);
  });

  it('overflow 后流静默 → 在下下个窗口边界(t=2000)补发 recovered,之后不再持有定时器', () => {
    emit('x'.repeat(3 * MiB)); // t=0 进入 overflow
    vi.advanceTimersByTime(1999);
    expect(overflowEvents(win)).toEqual(['terminal:overflow']);
    vi.advanceTimersByTime(1); // t=2000
    expect(overflowEvents(win)).toEqual(['terminal:overflow', 'terminal:overflow-recovered']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('overflow 后下一窗口来低速输出 → 立即 recovered(chunk 路径),恢复检查定时器一并清除', () => {
    emit('x'.repeat(3 * MiB));
    vi.advanceTimersByTime(1200); // t=1000 的恢复检查未恢复(上一窗口仍超阈值)→ 已重排到 t=2000
    emit('ok');
    expect(overflowEvents(win)).toEqual(['terminal:overflow', 'terminal:overflow-recovered']);
    vi.advanceTimersByTime(5); // 普通输出合批 flush
    expect(vi.getTimerCount()).toBe(0);
  });

  it('下一窗口仍持续高速 → 该窗口结束(t=2000)不恢复,再下一边界(t=3000)静默时恢复', () => {
    emit('x'.repeat(3 * MiB));
    vi.advanceTimersByTime(1500);
    emit('x'.repeat(3 * MiB)); // 新窗口单 chunk 即超阈值:保持 overflow,不重复发送
    vi.advanceTimersByTime(500); // t=2000
    expect(overflowEvents(win)).toEqual(['terminal:overflow']);
    vi.advanceTimersByTime(999);
    expect(overflowEvents(win)).toEqual(['terminal:overflow']);
    vi.advanceTimersByTime(1); // t=3000
    expect(overflowEvents(win)).toEqual(['terminal:overflow', 'terminal:overflow-recovered']);
  });

  // 惰性窗口基于墙钟:系统时间回拨不得让窗口长期不滚动(旧 setInterval 不受墙钟影响)。
  it('overflow 后系统时间回拨 1 小时 → 仍在 2s 内恢复,且后续窗口正常滚动', () => {
    emit('x'.repeat(3 * MiB));
    vi.setSystemTime(-3_600_000);
    vi.advanceTimersByTime(2000);
    expect(overflowEvents(win)).toEqual(['terminal:overflow', 'terminal:overflow-recovered']);
    emit('x'.repeat(1.5 * MiB));
    vi.advanceTimersByTime(1000);
    emit('x'.repeat(1.5 * MiB));
    expect(overflowEvents(win)).toEqual(['terminal:overflow', 'terminal:overflow-recovered']);
  });

  // 墙钟在一次 handleChunk 内的两次取时之间回拨(大 chunk 计数/截断时系统校时):旧实现窗口滚动与恢复定时器
  // delay 分别读 Date.now(),delay 被算成约 1 小时,流静默时卡在 overflow。吞吐窗口改用单调时钟后不受墙钟影响。
  it('进入 overflow 的同一次处理中墙钟回拨 1 小时 → 流静默仍在 t=2000 恢复', () => {
    const realNow = Date.now.bind(Date);
    let calls = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      calls += 1;
      return calls === 1 ? realNow() : realNow() - 3_600_000;
    });
    emit('x'.repeat(3 * MiB));
    vi.advanceTimersByTime(2000);
    expect(overflowEvents(win)).toEqual(['terminal:overflow', 'terminal:overflow-recovered']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('overflow 期间会话被清理 → 恢复检查定时器一并清除', () => {
    emit('x'.repeat(3 * MiB));
    vi.advanceTimersByTime(150); // 100ms overflow flush 已执行
    terminalService.forceKill('a');
    expect(vi.getTimerCount()).toBe(0);
  });
});
