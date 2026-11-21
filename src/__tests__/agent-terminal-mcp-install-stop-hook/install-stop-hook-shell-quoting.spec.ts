// BDD: agent-terminal-mcp-install-stop-hook · I13 hook 命令对 hookEventsDir 做 shell 转义(安全)
//
// 安全:hookEventsDir 来自 app.getPath('userData')(HOME / XDG_CONFIG_HOME / --user-data-dir)。此前原样拼进
// `mkdir -p "<dir>" && cat > "${CONTINUO_HOOK_EVENTS_DIR:-<dir>}/…"`:含 `$(…)` / 反引号 → 每次 Stop 执行命令;
// 含 `}` → `${VAR:-…}` 提前闭合;含 `"` → 引号闭合。该命令持久写进工作区配置。契约:路径 POSIX 单引号转义、
// 不嵌进 `${VAR:-…}`;已装的旧形态 managed 命令在下次 install 时原地升级。全部用真实 /bin/sh 执行验证。

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installStopHookForSession } from '../../../electron/main/services/mcp-tools-hook-bridge';

type Runner = 'cc' | 'codex';

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function makeDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'continuo-hook-quote-'));
  roots.push(d);
  return d;
}

async function readManagedCommands(cwd: string, runner: Runner): Promise<string[]> {
  if (runner === 'cc') {
    const settings = JSON.parse(
      await readFile(join(cwd, '.claude', 'settings.local.json'), 'utf8'),
    ) as { hooks: { Stop: Array<{ hooks: Array<{ command: string; _continuo_managed?: boolean }> }> } };
    return settings.hooks.Stop.flatMap((entry) => entry.hooks)
      .filter((hook) => hook._continuo_managed === true)
      .map((hook) => hook.command);
  }
  // 生成的 command 是 TOML basic string;其转义集(\" \\ \uXXXX)在这里与 JSON 字符串一致。
  const toml = await readFile(join(cwd, '.codex', 'config.toml'), 'utf8');
  return [...toml.matchAll(/^command = (.*)$/gm)].map((m) => JSON.parse(m[1]!) as string);
}

function runHook(command: string, runCwd: string, extraEnv: Record<string, string> = {}): void {
  execFileSync('/bin/sh', ['-c', command], {
    cwd: runCwd,
    input: '{"session_id":"s"}',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      CONTINUO_WINDOW_ID: '1',
      CONTINUO_TERMINAL_SESSION_ID: 'term-1',
      ...extraEnv,
    },
  });
}

/** 改造前的命令形态(带会话 id,但 hookEventsDir 原样嵌进双引号与 `${VAR:-…}`)。 */
function preQuotingCommand(runner: Runner, dir: string): string {
  const prefix = `umask 077; mkdir -p "${dir}" && cat > "\${CONTINUO_HOOK_EVENTS_DIR:-${dir}}/`;
  return runner === 'cc'
    ? `${prefix}cc_\${CONTINUO_WINDOW_ID:-unknown}_\${CONTINUO_TERMINAL_SESSION_ID:-unknown}_\${CLAUDE_CODE_SESSION_ID:-unknown}_$(date +%s%N).jsonl"`
    : `${prefix}codex_\${CONTINUO_WINDOW_ID:-unknown}_\${CONTINUO_TERMINAL_SESSION_ID:-unknown}_$(date +%s%N).jsonl"`;
}

const HOSTILE_NAMES: ReadonlyArray<readonly [label: string, name: string]> = [
  ['空格', 'hook events'],
  ['$(…) 命令替换', '$(touch PWNED)'],
  ['反引号命令替换', '`touch PWNED`'],
  ['右花括号', 'a}b'],
  ['双引号', 'a"b'],
  ['单引号', "a'b"],
  ['反斜杠', 'a\\b'],
  ['中文', '钩子 事件'],
  ['混合', `x'"$(touch PWNED)\`touch PWNED\`};touch PWNED;#`],
];

describe.skipIf(process.platform === 'win32')('I13 hook 命令对 hookEventsDir 做 shell 转义', () => {
  for (const runner of ['cc', 'codex'] as const) {
    for (const [label, name] of HOSTILE_NAMES) {
      it(`${runner}: hookEventsDir 含${label} → 事件只落在该目录内,不执行路径里的任何命令`, async () => {
        const cwd = await makeDir();
        const base = await makeDir();
        const eventsDir = join(base, name);
        await expect(installStopHookForSession(cwd, runner, eventsDir)).resolves.toEqual({
          installed: true,
        });
        const commands = await readManagedCommands(cwd, runner);
        expect(commands).toHaveLength(1);

        runHook(commands[0]!, base);

        // base 下只有事件目录本身:没有标记文件、没有被拆词/截断出的其它目录。
        expect(await readdir(base)).toEqual([name]);
        const files = await readdir(eventsDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(
          runner === 'cc' ? /^cc_1_term-1_unknown_.*\.jsonl$/ : /^codex_1_term-1_.*\.jsonl$/,
        );
        expect(await readFile(join(eventsDir, files[0]!), 'utf8')).toBe('{"session_id":"s"}');
        expect(await readdir(cwd)).toEqual([runner === 'cc' ? '.claude' : '.codex']);

        // 幂等:同目录再装不重写。
        await expect(installStopHookForSession(cwd, runner, eventsDir)).resolves.toEqual({
          installed: false,
          reason: 'already-installed',
        });
      });
    }

    it(`${runner}: CONTINUO_HOOK_EVENTS_DIR 环境变量仍优先于写入的默认目录`, async () => {
      const cwd = await makeDir();
      const base = await makeDir();
      const defaultName = 'default $(touch PWNED)';
      const overrideName = "over ride'}";
      await expect(
        installStopHookForSession(cwd, runner, join(base, defaultName)),
      ).resolves.toEqual({ installed: true });
      const [command] = await readManagedCommands(cwd, runner);

      runHook(command!, base, { CONTINUO_HOOK_EVENTS_DIR: join(base, overrideName) });

      // 事件写进环境变量指定的目录;默认目录不被使用(也不产生标记文件)。
      expect(await readdir(base)).toEqual([overrideName]);
      expect(await readdir(join(base, overrideName))).toHaveLength(1);
    });

    it(`${runner}: 已装的旧形态 managed 命令(路径未转义)原地升级为新形态,不产生重复条目`, async () => {
      const cwd = await makeDir();
      const base = await makeDir();
      const eventsName = 'ev $(touch PWNED)';
      const eventsDir = join(base, eventsName);
      const legacy = preQuotingCommand(runner, eventsDir);
      if (runner === 'cc') {
        await mkdir(join(cwd, '.claude'));
        await writeFile(
          join(cwd, '.claude', 'settings.local.json'),
          JSON.stringify({
            hooks: {
              Stop: [
                { hooks: [{ type: 'command', command: 'echo user-stop' }] },
                { hooks: [{ type: 'command', command: legacy, _continuo_managed: true }] },
              ],
            },
          }),
        );
      } else {
        await mkdir(join(cwd, '.codex'));
        await writeFile(
          join(cwd, '.codex', 'config.toml'),
          [
            '# continuo-managed',
            '[[hooks.Stop]]',
            '[[hooks.Stop.hooks]]',
            'type = "command"',
            `command = ${JSON.stringify(legacy)}`,
            '',
          ].join('\n'),
        );
      }

      await expect(installStopHookForSession(cwd, runner, eventsDir)).resolves.toEqual({
        installed: true,
      });
      const commands = await readManagedCommands(cwd, runner);
      expect(commands).toHaveLength(1);
      expect(commands[0]).not.toBe(legacy);
      if (runner === 'cc') {
        const raw = await readFile(join(cwd, '.claude', 'settings.local.json'), 'utf8');
        const parsed = JSON.parse(raw) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } };
        expect(parsed.hooks.Stop).toHaveLength(2);
        expect(parsed.hooks.Stop[0]!.hooks[0]!.command).toBe('echo user-stop');
      }

      runHook(commands[0]!, base);
      expect(await readdir(base)).toEqual([eventsName]);
      expect(await readdir(eventsDir)).toHaveLength(1);

      await expect(installStopHookForSession(cwd, runner, eventsDir)).resolves.toEqual({
        installed: false,
        reason: 'already-installed',
      });
    });
  }
});
