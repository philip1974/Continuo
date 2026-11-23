// BDD: agent-terminal-mcp-install-stop-hook · I10 hook 事件私有权限(多用户 Linux)
//
// 安全(H2):hook-events 目录与 hook 命令写出的事件文件(含 last_assistant_message 等会话内容)此前按默认
// umask 建成 0755 / 0644,同机其他用户可列目录、读事件。契约:目录 0700(已存在也收紧),hook 命令在
// `umask 077` 下创建目录与事件文件(0700 / 0600)。

import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureHookEventsDir,
  inferRunner,
  installStopHookForSession,
} from '../../../electron/main/services/mcp-tools-hook-bridge';

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function makeDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'continuo-hook-perms-'));
  roots.push(d);
  return d;
}

async function installedCommand(cwd: string, runner: 'cc' | 'codex', dir: string): Promise<string> {
  await expect(installStopHookForSession(cwd, runner, dir)).resolves.toEqual({ installed: true });
  if (runner === 'cc') {
    const settings = JSON.parse(
      await readFile(join(cwd, '.claude', 'settings.local.json'), 'utf8'),
    ) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } };
    return settings.hooks.Stop[0]!.hooks[0]!.command;
  }
  const toml = await readFile(join(cwd, '.codex', 'config.toml'), 'utf8');
  return JSON.parse(/^command = (.*)$/m.exec(toml)![1]!) as string;
}

describe.skipIf(process.platform === 'win32')('I10 hook 事件私有权限', () => {
  for (const label of ['claude', 'codex'] as const) {
    it(`${label}: 真实 hook 命令(/bin/sh,宽松 umask 022)写出的目录 0700、事件文件 0600`, async () => {
      const cwd = await makeDir();
      const eventsDir = join(await makeDir(), 'hook-events');
      const runner = inferRunner(label);
      const command = await installedCommand(cwd, runner as 'cc' | 'codex', eventsDir);

      execFileSync('/bin/sh', ['-c', `umask 022; ${command}`], {
        input: '{"session_id":"s"}',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          CONTINUO_WINDOW_ID: '1',
          CONTINUO_TERMINAL_SESSION_ID: 'term-1',
        },
      });

      expect((await stat(eventsDir)).mode & 0o777).toBe(0o700);
      const files = await readdir(eventsDir);
      expect(files).toHaveLength(1);
      expect((await stat(join(eventsDir, files[0]!))).mode & 0o777).toBe(0o600);
    });
  }

  it('ensureHookEventsDir:新建为 0700;已存在的 0755 目录收紧为 0700', async () => {
    const base = await makeDir();
    const fresh = join(base, 'fresh');
    await ensureHookEventsDir(fresh);
    expect((await stat(fresh)).mode & 0o777).toBe(0o700);

    const existing = join(base, 'existing');
    await mkdir(existing);
    await chmod(existing, 0o755);
    await ensureHookEventsDir(existing);
    expect((await stat(existing)).mode & 0o777).toBe(0o700);
  });
});
