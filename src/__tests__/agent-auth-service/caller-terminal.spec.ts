// BDD agent-auth-service:授权弹窗显示发起终端(见同目录 README)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWindow } from '../migration-step1-pty-handover/fixtures';

const sessionManagerMock = vi.hoisted(() => ({
  options: undefined as
    | {
        onData?: (sessionId: string, chunk: string) => void;
        onExit?: (sessionId: string, info: { exitCode: number; signal?: number }) => void;
      }
    | undefined,
  create: vi.fn(),
  sendInput: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  getBufferSnapshot: vi.fn(),
  readOutput: vi.fn(),
}));

const shellMock = vi.hoisted(() => ({
  cleanup: vi.fn(async () => {}),
  prepareShellIntegrationEnv: vi.fn(async (_shell: string, env: Record<string, string | undefined>) => ({
    env,
    args: [],
    cleanup: shellMock.cleanup,
  })),
}));

vi.mock('@continuo-terminal/server-node', async () => ({
  ...(await vi.importActual<typeof import('@continuo-terminal/server-node')>(
    '@continuo-terminal/server-node',
  )),
  SessionManager: vi.fn().mockImplementation((options) => {
    sessionManagerMock.options = options;
    return {
      create: sessionManagerMock.create,
      sendInput: sessionManagerMock.sendInput,
      resize: sessionManagerMock.resize,
      kill: sessionManagerMock.kill,
      getBufferSnapshot: sessionManagerMock.getBufferSnapshot,
      readOutput: sessionManagerMock.readOutput,
    };
  }),
  prepareShellIntegrationEnv: shellMock.prepareShellIntegrationEnv,
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => `/tmp/test-${key}`),
  },
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



// 授权弹窗的「发起终端」:每个终端 PTY 签发一个 MCP token(注入其 env),main 按调用方 token 反查会话 id(只作显示)。
describe('sessionIdForMcpToken', () => {
  beforeEach(() => {
    terminalService.__resetForTest();
    terminalSessions._reset();
    setMcpRevokers({ byToken: vi.fn(), byWindow: vi.fn() });
    sessionManagerMock.create.mockReset().mockResolvedValue({ session_id: 'created' });
    sessionManagerMock.kill.mockReset().mockResolvedValue({});
    shellMock.cleanup.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    terminalService.__resetForTest();
  });

  it('按 token 找到持有它的终端;未知 / 空 token / 终端已移除 → null', async () => {
    const win = makeWindow(7);
    await terminalService.createTerminal('a', win, '/bin/zsh', [], '/tmp', undefined, { mcpToken: 'tok-a' });
    await terminalService.createTerminal('b', win, '/bin/zsh', [], '/tmp', undefined, { mcpToken: 'tok-b' });
    expect(terminalService.sessionIdForMcpToken('tok-b')).toBe('b');
    expect(terminalService.sessionIdForMcpToken('tok-a')).toBe('a');
    expect(terminalService.sessionIdForMcpToken('nope')).toBeNull();
    expect(terminalService.sessionIdForMcpToken('')).toBeNull();
    terminalService.forceKill('a');
    expect(terminalService.sessionIdForMcpToken('tok-a')).toBeNull();
  });
});
