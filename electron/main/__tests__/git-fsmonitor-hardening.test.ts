// 安全:恶意 workspace 的 `.git/config` 写 `core.fsmonitor = "<cmd>"`,插件经宿主 shell.exec / 流式 shell
// 在其中跑 `git status` 即执行任意命令。宿主为插件子进程注入 git 命令行作用域 core.fsmonitor=false 兜底。
// 用真实 git 仓库 + 会创建标记文件的 fsmonitor 脚本验证(本机需有 git ≥2.31)。
// 范围:只验证 fsmonitor —— filter/textconv/sshCommand 等同类向量宿主无法通配禁用,需插件自行加固
//(见 lib/child-spawn-hardening 文件头「覆盖范围」与 src/__tests__/shell-service/README.md)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

import { execShell } from '../services/shell.service';
import { registerPluginShellStreamHandlers } from '../services/plugin-shell-stream.service';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../shared/plugin-shell-stream-channels';

let repo: string;
let marker: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'fsmonitor-rce-'));
  marker = path.join(repo, 'PWNED');
  git(['init', '-q']);
  await writeFile(path.join(repo, 'a.txt'), 'a');
  git(['add', 'a.txt']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
  const hook = path.join(repo, 'evil-fsmonitor.sh');
  await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`);
  await chmod(hook, 0o755);
  git(['config', 'core.fsmonitor', hook]);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

describe.skipIf(process.platform === 'win32')('插件子进程 git core.fsmonitor 兜底', () => {
  it('前提:不加防护时 git status 确实会执行仓库配置的 fsmonitor', () => {
    git(['status', '--porcelain']);
    expect(existsSync(marker)).toBe(true);
  });

  it('shell.exec 跑 git status 不执行 fsmonitor 命令', async () => {
    const r = await execShell({ cmd: 'git', args: ['status', '--porcelain'], cwd: repo });
    expect(r.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('shell.exec 调用方 env 自带 GIT_CONFIG_COUNT 时同样不执行(追加而非被覆盖)', async () => {
    const r = await execShell({
      cmd: 'git',
      args: ['status', '--porcelain'],
      cwd: repo,
      env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'color.ui', GIT_CONFIG_VALUE_0: 'never' },
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('流式 shell 跑 git status 不执行 fsmonitor 命令', async () => {
    const handlers = new Map<string, (...a: unknown[]) => Promise<void>>();
    registerPluginShellStreamHandlers({
      handle: (ch: string, h: (...a: unknown[]) => Promise<void>) => handlers.set(ch, h),
    } as never);
    const sent: { kind: string; payload: unknown }[] = [];
    const sender = {
      id: 9001,
      isDestroyed: () => false,
      send: (_ch: string, p: { kind: string; payload: unknown }) => sent.push(p),
      once: () => {},
      on: () => {},
    };
    await handlers.get(PLUGIN_SHELL_STREAM_CHANNELS.START)!(
      { sender, senderFrame: { url: 'file:///app/index.html' } },
      'git-status',
      'git',
      ['status', '--porcelain'],
      { cwd: repo },
    );
    const started = Date.now();
    while (!sent.some((e) => e.kind === 'exit') && Date.now() - started < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(sent.find((e) => e.kind === 'exit')?.payload).toMatchObject({ exitCode: 0 });
    expect(existsSync(marker)).toBe(false);
  });
});
