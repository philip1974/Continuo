import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeWindow } from '../migration-step1-pty-handover/fixtures';

// 捕获 Continuo 实例化 SessionManager 时传入的构造选项，
// 用以断言 maxBytes 缓冲容量契约（见 README B1-B3）。
const sessionManagerMock = vi.hoisted(() => ({
  options: undefined as { maxBytes?: number } | undefined,
  create: vi.fn(),
  sendInput: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(async () => ({})),
  getBufferSnapshot: vi.fn(() => ({ data: '', nextSeq: 1, truncated: false })),
  readOutput: vi.fn(),
}));

const shellMock = vi.hoisted(() => ({
  cleanup: vi.fn(async () => {}),
  prepareShellIntegrationEnv: vi.fn(
    async (_shell: string, env: Record<string, string | undefined>) => ({
      env,
      cleanup: shellMock.cleanup,
    }),
  ),
}));

vi.mock('@continuo-terminal/server-node', async () => ({
  ...(await vi.importActual<typeof import('@continuo-terminal/server-node')>(
    '@continuo-terminal/server-node',
  )),
  SessionManager: vi.fn().mockImplementation((options) => {
    sessionManagerMock.options = options;
    return sessionManagerMock;
  }),
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

import * as service from '../../../electron/main/services/terminal.service';

// @continuo-terminal/server-node 的库默认 MAX_BUFFER_BYTES（私有 const，未导出）。
const LIBRARY_DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const ONE_MIB = 1 * 1024 * 1024;

describe('terminal-buffer-capacity · 终端输出缓冲区容量', () => {
  beforeEach(() => {
    service.__resetForTest();
    sessionManagerMock.options = undefined;
    sessionManagerMock.create.mockReset().mockResolvedValue({ session_id: 'created' });
    sessionManagerMock.sendInput.mockReset().mockResolvedValue({});
    sessionManagerMock.resize.mockReset().mockResolvedValue(undefined);
    shellMock.cleanup.mockReset().mockResolvedValue(undefined);
    shellMock.prepareShellIntegrationEnv.mockClear();
  });

  afterEach(() => {
    service.__resetForTest();
  });

  async function instantiateSessionManager(): Promise<void> {
    // SessionManager 是惰性单例，首次创建终端时才构造 —— 触发它以捕获选项。
    const win = makeWindow(1);
    await service.createTerminal('cap-probe', win, '/bin/zsh', [], '/tmp');
  }

  it('B1 缓冲容量恢复为库默认 4 MiB', async () => {
    await instantiateSessionManager();

    expect(sessionManagerMock.options?.maxBytes).toBe(LIBRARY_DEFAULT_MAX_BUFFER_BYTES);
  });

  it('B2 容量是显式声明，不沿用上游隐式默认', async () => {
    await instantiateSessionManager();

    // maxBytes 必须在构造选项里被显式给出（而非 undefined 落到库默认），
    // 使容量成为仓内可审计的契约。
    expect(sessionManagerMock.options).toBeDefined();
    expect(sessionManagerMock.options?.maxBytes).toBeTypeOf('number');
    expect(sessionManagerMock.options?.maxBytes).not.toBeUndefined();
  });

  it('B3 防回退下限：容量不得低于 1 MiB', async () => {
    await instantiateSessionManager();

    expect(sessionManagerMock.options?.maxBytes).toBeGreaterThanOrEqual(ONE_MIB);
  });
});
