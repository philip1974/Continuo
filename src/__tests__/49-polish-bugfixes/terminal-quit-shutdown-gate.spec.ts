// 终审 P1:终端退出闸。before-quit 的 termService.cleanupAll() 此前只杀调用瞬间的 instances 快照;清理期间
// (debug teardown 数秒、MCP host 关闭前)agent 经 terminal.create_session 新建的 PTY 不会被强杀,窗口关闭只走
// 3s grace,主进程退出后升级定时器不执行 → 忽略 SIGINT/SIGHUP 的长期命令成为孤儿。
// 与 shell exec / stream / debug launch 同一模式:cleanupAll 开始即置 shuttingDown,此后 createTerminal 在 spawn
// 前拒绝(TERMINAL_CREATE_CANCELLED);结束前再扫登记表兜底强杀清理期间漏网的 PTY。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWindow } from '../migration-step1-pty-handover/fixtures';

const sm = vi.hoisted(() => ({
  create: vi.fn(),
  sendInput: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  getBufferSnapshot: vi.fn(),
  readOutput: vi.fn(),
}));

const shellMock = vi.hoisted(() => ({
  prepareShellIntegrationEnv: vi.fn(async (_shell: string, env: Record<string, string | undefined>) => ({
    env,
    args: [],
    cleanup: async () => {},
  })),
}));

vi.mock('@continuo-terminal/server-node', async () => ({
  ...(await vi.importActual<typeof import('@continuo-terminal/server-node')>(
    '@continuo-terminal/server-node',
  )),
  SessionManager: vi.fn().mockImplementation(() => sm),
  prepareShellIntegrationEnv: shellMock.prepareShellIntegrationEnv,
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
import { setMcpRevokers } from '../../../electron/main/services/mcp-host.service';
import { ERROR_CODES } from '../../../electron/shared/error-codes';

const ZSH = '/bin/zsh';

describe('终端退出闸:cleanupAll 开始后拒绝新建 PTY 并兜底强杀漏网会话', () => {
  const byToken = vi.fn();

  beforeEach(() => {
    terminalService.__resetForTest();
    terminalService.resetTerminalShutdownForTest();
    setMcpRevokers({ byToken, byWindow: vi.fn() });
    byToken.mockReset();
    sm.create.mockReset().mockResolvedValue({ session_id: 'x' });
    sm.kill.mockReset().mockResolvedValue({});
    sm.sendInput.mockReset().mockResolvedValue({});
    shellMock.prepareShellIntegrationEnv.mockClear();
  });

  afterEach(() => {
    terminalService.__resetForTest();
    terminalService.resetTerminalShutdownForTest();
  });

  it('cleanupAll 之后 createTerminal 以 TERMINAL_CREATE_CANCELLED 拒绝,不 spawn(已签发的 mcpToken 由签发它的 ipc 层吊销)', async () => {
    await terminalService.cleanupAll();

    await expect(
      terminalService.createTerminal('late', makeWindow(1), ZSH, [], '/tmp', undefined, {
        mcpToken: 'tok-late',
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.TERMINAL_CREATE_CANCELLED });
    // 入口即拒:连 shell integration 准备都不做。
    expect(shellMock.prepareShellIntegrationEnv).not.toHaveBeenCalled();
    expect(sm.create).not.toHaveBeenCalled();
    expect(terminalService.has('late')).toBe(false);
  });

  it('cleanupAll 进行中(SIGKILL 未结算)新建的 createTerminal 被拒且不 spawn', async () => {
    await terminalService.createTerminal('a', makeWindow(1), ZSH, [], '/tmp');
    let releaseKill!: () => void;
    sm.kill.mockReturnValueOnce(new Promise<void>((r) => (releaseKill = r)));

    const cleaning = terminalService.cleanupAll();
    sm.create.mockClear();
    shellMock.prepareShellIntegrationEnv.mockClear();
    await expect(
      terminalService.createTerminal('mid', makeWindow(1), ZSH, [], '/tmp'),
    ).rejects.toMatchObject({ code: ERROR_CODES.TERMINAL_CREATE_CANCELLED });
    expect(shellMock.prepareShellIntegrationEnv).not.toHaveBeenCalled();
    expect(sm.create).not.toHaveBeenCalled();

    releaseKill();
    await cleaning;
  });

  it('闸前已开始、shell integration 准备期间清理开始的 create 在 spawn 前被拒', async () => {
    await terminalService.createTerminal('a', makeWindow(1), ZSH, [], '/tmp');
    // 'b' 的 shell integration 准备卡住:create 开始于闸前,登记(instances.set)发生在清理进行中。
    let releasePrep!: () => void;
    shellMock.prepareShellIntegrationEnv.mockImplementationOnce(
      (_s: string, env: Record<string, string | undefined>) =>
        new Promise((r) => {
          releasePrep = () => r({ env, args: [], cleanup: async () => {} });
        }),
    );
    const creatingB = terminalService.createTerminal('b', makeWindow(1), ZSH, [], '/tmp', undefined, {
      mcpToken: 'tok-b',
    });
    await Promise.resolve();

    let releaseKillA!: () => void;
    sm.kill.mockReturnValueOnce(new Promise<void>((r) => (releaseKillA = r)));
    const cleaning = terminalService.cleanupAll();
    releasePrep();
    await expect(creatingB).rejects.toMatchObject({
      code: ERROR_CODES.TERMINAL_CREATE_CANCELLED,
    });
    releaseKillA();
    await cleaning;

    expect(sm.create.mock.calls.some(([arg]) => arg.session_id === 'b')).toBe(false);
    expect(terminalService.has('b')).toBe(false);
  });

  it('spawn 在途时 cleanupAll 开始:spawn 完成后的 PTY 被强杀,createTerminal 以取消错误收场', async () => {
    let releaseCreate!: () => void;
    sm.create.mockReturnValueOnce(new Promise<void>((r) => (releaseCreate = r)));
    const creating = terminalService.createTerminal('c', makeWindow(1), ZSH, [], '/tmp');
    // 等到 sm.create 已被调用(PTY spawn 在途)。
    await vi.waitFor(() => expect(sm.create).toHaveBeenCalled());

    const cleaning = terminalService.cleanupAll();
    releaseCreate();
    await expect(creating).rejects.toMatchObject({
      code: ERROR_CODES.TERMINAL_CREATE_CANCELLED,
    });
    await cleaning;

    const killsForC = sm.kill.mock.calls.filter(([arg]) => arg.session_id === 'c');
    // cleanupAll 那次 kill 早于 PTY 实际建立(server-node 侧 session 尚不存在);spawn 完成后必须再强杀一次。
    expect(killsForC.length).toBeGreaterThanOrEqual(2);
    expect(terminalService.has('c')).toBe(false);
  });

  it('resetTerminalShutdownForTest 复位后可再次创建', async () => {
    await terminalService.cleanupAll();
    terminalService.resetTerminalShutdownForTest();
    await terminalService.createTerminal('again', makeWindow(1), ZSH, [], '/tmp');
    expect(terminalService.has('again')).toBe(true);
  });
  // perf:退出强杀时会话元数据仍在,此前每个 PTY 都把最多 4MB 输出缓冲拼成「已退出历史」快照(10 个满载终端
  // ~40ms 主线程 + ~40MB 堆),进程随即退出、快照无人读取。退出期间不再保留。
  it('cleanupAll 强杀时不为已退出会话拍输出快照', async () => {
    await terminalService.createTerminal('h', makeWindow(1), ZSH, [], '/tmp');
    terminalSessions.add({ id: 'h', title: 'h', cwd: '/tmp', originHint: 'user', ownerWindowId: 1 });
    sm.getBufferSnapshot.mockReset().mockReturnValue({ data: 'x'.repeat(1024), seq: 1 });
    try {
      await terminalService.cleanupAll();
      expect(sm.getBufferSnapshot).not.toHaveBeenCalled();
    } finally {
      terminalSessions._reset();
    }
  });
});
