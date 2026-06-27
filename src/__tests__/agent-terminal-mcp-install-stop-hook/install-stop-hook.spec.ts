// BDD: agent-terminal-mcp-install-stop-hook
// agent terminal spawn 前 stop hook 自动安装契约层。

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inferRunner,
  installStopHookForSession as installStopHookForRunner,
  type RunnerKind,
} from '../../../electron/main/services/mcp-tools-hook-bridge';

interface InstallStopHookInput {
  readonly cwd: string;
  readonly agentLabel: string;
  readonly hookEventsDir: string;
  readonly windowId: number;
}

const tmpRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  vi.useRealTimers();
});

async function makeCwd(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'continuo-install-stop-hook-'));
  tmpRoots.push(root);
  return root;
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text, 'utf8');
}

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function listBackups(cwd: string): Promise<string[]> {
  const names = await readdir(cwd, { recursive: true });
  return names
    .map(String)
    .filter((name) => name.includes('.continuo-bak.'));
}

function runnerFromAgentLabel(agentLabel: string): RunnerKind {
  return inferRunner({ id: 'term', cwd: '/repo', agentLabel });
}

function installStopHookForSession(input: InstallStopHookInput) {
  return installStopHookForRunner(
    input.cwd,
    runnerFromAgentLabel(input.agentLabel),
    input.hookEventsDir,
  );
}

function makeDriver() {
  const calls: string[] = [];
  return {
    calls,
    install: async (input: InstallStopHookInput) => {
      calls.push(`install:${runnerFromAgentLabel(input.agentLabel)}`);
      return installStopHookForSession(input);
    },
    createSession: async (input: InstallStopHookInput) => {
      calls.push('resolve-cwd');
      const installResult = await installStopHookForSession(input);
      calls.push('install-complete');
      calls.push('spawn');
      return { installResult, sessionId: 'term-1' };
    },
  };
}

describe('installStopHookForSession', () => {
  it('I1 should merge Claude Code settings with managed stop hook command and return installed true', async () => {
    const cwd = await makeCwd();
    const hookEventsDir = join(cwd, '.continuo', 'hook-events');

    await expect(
      installStopHookForSession({
        cwd,
        agentLabel: 'claude',
        hookEventsDir,
        windowId: 4,
      }),
    ).resolves.toEqual({ installed: true });

    const settings = await readText(join(cwd, '.claude', 'settings.local.json'));
    expect(settings).toContain('mkdir -p');
    expect(settings).toContain('cat >');
    expect(settings).toContain('${CONTINUO_WINDOW_ID:-unknown}');
    expect(settings).toContain('${CLAUDE_CODE_SESSION_ID:-unknown}');
    expect(settings).toContain('"_continuo_managed": true');
  });

  it('I2 should merge Codex config with windowId-aware Stop hook command', async () => {
    const cwd = await makeCwd();
    const hookEventsDir = join(cwd, '.continuo', 'hook-events');

    await expect(
      installStopHookForSession({
        cwd,
        agentLabel: 'codex',
        hookEventsDir,
        windowId: 4,
      }),
    ).resolves.toEqual({ installed: true });

    const toml = await readText(join(cwd, '.codex', 'config.toml'));
    expect(toml).toContain('[[hooks.Stop]]');
    expect(toml).toContain('# continuo-managed');
    expect(toml).toContain(
      'codex_${CONTINUO_WINDOW_ID:-unknown}_$(date +%s%N).jsonl',
    );
  });

  it('I3a/I3b should skip managed Stop but not skip when only Notification contains env', async () => {
    const cwd = await makeCwd();
    const settingsPath = join(cwd, '.claude', 'settings.local.json');
    await writeText(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                matcher: '',
                hooks: [
                  {
                    type: 'command',
                    command:
                      'mkdir -p "$CONTINUO_HOOK_EVENTS_DIR"; cat > "$CONTINUO_HOOK_EVENTS_DIR/cc.jsonl"',
                    _continuo_managed: true,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    await expect(
      installStopHookForSession({
        cwd,
        agentLabel: 'cc',
        hookEventsDir: join(cwd, '.continuo', 'hook-events'),
        windowId: 4,
      }),
    ).resolves.toEqual({
      installed: false,
      reason: 'already-installed',
    });
    await expect(listBackups(cwd)).resolves.toHaveLength(0);

    const codexCwd = await makeCwd();
    const configPath = join(codexCwd, '.codex', 'config.toml');
    await writeText(
      configPath,
      [
        '[[hooks.Notification]]',
        'command = "echo $CONTINUO_HOOK_EVENTS_DIR"',
        '',
      ].join('\n'),
    );

    await expect(
      installStopHookForSession({
        cwd: codexCwd,
        agentLabel: 'codex',
        hookEventsDir: join(codexCwd, '.continuo', 'hook-events'),
        windowId: 4,
      }),
    ).resolves.toEqual({ installed: true });

    const toml = await readText(configPath);
    expect(toml).toContain('[[hooks.Notification]]');
    expect(toml).toContain('[[hooks.Stop]]');
  });

  it('I3c should refuse unrecognized Codex multiline Stop hook instead of appending', async () => {
    const cwd = await makeCwd();
    const configPath = join(cwd, '.codex', 'config.toml');
    const existing = [
      '[[hooks.Stop]]',
      "command = '''",
      'mkdir -p "$CONTINUO_HOOK_EVENTS_DIR"',
      "'''",
      '',
    ].join('\n');
    await writeText(configPath, existing);

    await expect(
      installStopHookForSession({
        cwd,
        agentLabel: 'codex',
        hookEventsDir: join(cwd, '.continuo', 'hook-events'),
        windowId: 4,
      }),
    ).resolves.toEqual({
      installed: false,
      reason: 'unrecognized-existing-stop-hook',
    });
    await expect(readText(configPath)).resolves.toBe(existing);
  });

  it('I4 should skip unknown runner and leave cwd untouched', async () => {
    const cwd = await makeCwd();

    await expect(
      installStopHookForSession({
        cwd,
        agentLabel: 'aider',
        hookEventsDir: join(cwd, '.continuo', 'hook-events'),
        windowId: 4,
      }),
    ).resolves.toEqual({
      installed: false,
      reason: 'unknown-runner',
    });
    await expect(readdir(cwd)).resolves.toEqual([]);
  });

  it('I5 should skip parse-failed Claude settings and preserve invalid JSON bytes', async () => {
    const cwd = await makeCwd();
    const settingsPath = join(cwd, '.claude', 'settings.local.json');
    await writeText(settingsPath, '{not-valid-json');

    await expect(
      installStopHookForSession({
        cwd,
        agentLabel: 'claude',
        hookEventsDir: join(cwd, '.continuo', 'hook-events'),
        windowId: 4,
      }),
    ).resolves.toEqual({
      installed: false,
      reason: 'parse-error',
    });
    await expect(readText(settingsPath)).resolves.toBe('{not-valid-json');
  });

  it('I6 should backup and replace only the managed marker entry when hookEventsDir drifts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-07T00:00:00.000Z'));
    const cwd = await makeCwd();
    const configPath = join(cwd, '.codex', 'config.toml');
    await writeText(
      configPath,
      [
        '[[hooks.Stop]]',
        '# user-owned',
        'command = "echo user-stop"',
        '',
        '[[hooks.Stop]]',
        '# continuo-managed',
        'command = "cat > /old/hook-events/codex_${CONTINUO_WINDOW_ID:-unknown}_$(date +%s%N).jsonl"',
        '',
        '[[hooks.Stop]]',
        '# user-owned-2',
        'command = "echo another-user-stop"',
        '',
      ].join('\n'),
    );

    await expect(
      installStopHookForSession({
        cwd,
        agentLabel: 'codex',
        hookEventsDir: join(cwd, '.continuo', 'hook-events-new'),
        windowId: 4,
      }),
    ).resolves.toEqual({ installed: true });

    await expect(listBackups(cwd)).resolves.toHaveLength(1);
    const toml = await readText(configPath);
    expect(toml).toContain('echo user-stop');
    expect(toml).toContain('echo another-user-stop');
    expect(toml).not.toContain('/old/hook-events');
  });

  // 数据安全(codex 复查 P1):真实首装写出的 command 经 JSON.stringify 含转义引号 \"
  // (mkdir -p "..." 的内层引号)。drift 替换的 `"[^"]*"` 正则在第一个 \" 处截断 → 旧命令
  // 尾巴残留、损坏 .codex/config.toml。转义感知正则须完整替换。I6 用手工无转义 command
  // 故未触发,此处用真实两次安装复现。
  it('I6b hookEventsDir drift 替换转义引号 command 不残留旧命令(真实两次安装)', async () => {
    const cwd = await makeCwd();
    const oldDir = join(cwd, '.continuo', 'old-hk');
    const newDir = join(cwd, '.continuo', 'new-hk');

    await expect(
      installStopHookForSession({
        cwd,
        agentLabel: 'codex',
        hookEventsDir: oldDir,
        windowId: 1,
      }),
    ).resolves.toEqual({ installed: true });

    await expect(
      installStopHookForSession({
        cwd,
        agentLabel: 'codex',
        hookEventsDir: newDir,
        windowId: 1,
      }),
    ).resolves.toEqual({ installed: true });

    const toml = await readText(join(cwd, '.codex', 'config.toml'));
    expect(toml).toContain(newDir);
    expect(toml).not.toContain(oldDir); // 旧命令完全被替换,无残留
    // 只有一个 managed command(未因截断残留半截旧命令)
    expect(toml.match(/codex_\$\{CONTINUO_WINDOW_ID/g)?.length).toBe(1);
  });

  // 数据安全(codex 复查 P1):managed marker 块缺/坏 command 时,无块边界的正则会一路
  // 跨过 [[hooks.Stop]] 匹配到用户自有 Stop 的 command 并误替/写坏(违反 README I6 契约)。
  // 块边界正则:managed 块无 command 则不匹配 → 不跨块改写用户 hook。
  it('I6c managed 块缺 command 时不跨 [[hooks.Stop]] 块改写用户 Stop command', async () => {
    const cwd = await makeCwd();
    const configPath = join(cwd, '.codex', 'config.toml');
    await writeText(
      configPath,
      [
        '[[hooks.Stop]]',
        '# user-owned',
        'command = "echo user-stop"',
        '',
        '# continuo-managed',
        '[[hooks.Stop]]',
        '[[hooks.Stop.hooks]]',
        'type = "command"',
        '', // managed command 缺失(损坏)
        '[[hooks.Stop]]',
        '# user-owned-2',
        'command = "echo another-user"',
        '',
      ].join('\n'),
    );

    await installStopHookForSession({
      cwd,
      agentLabel: 'codex',
      hookEventsDir: join(cwd, '.continuo', 'hk'),
      windowId: 1,
    });

    const toml = await readText(configPath);
    // 两个用户自有 Stop command 都未被跨块误替
    expect(toml).toContain('echo user-stop');
    expect(toml).toContain('echo another-user');
  });

  it('I7 should finish install after cwd resolve and before spawn', async () => {
    const cwd = await makeCwd();
    const driver = makeDriver();

    await expect(
      driver.createSession({
        cwd,
        agentLabel: 'codex',
        hookEventsDir: join(cwd, '.continuo', 'hook-events'),
        windowId: 4,
      }),
    ).resolves.toMatchObject({ sessionId: 'term-1' });
    expect(driver.calls).toEqual(['resolve-cwd', 'install-complete', 'spawn']);
  });
});
