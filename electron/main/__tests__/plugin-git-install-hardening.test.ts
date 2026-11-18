// 安全:插件 git 安装(installFromGit → runGit)的 git 子进程不得被用户全局 ~/.gitconfig 里的
// filter.lfs.* 驱动 git-lfs。被攻破的插件仓库放 `.lfsconfig`(lfs.url=内网 / 127.0.0.1 地址)+ LFS 指针
// 文件,clone 检出时 git-lfs 即向任意地址发请求(GIT_ALLOW_PROTOCOL 管不到 git-lfs 自身 HTTP),
// 发生在用户启用 / 授权插件之前。
// 做法:mock spawn 捕获 runGit 真实使用的 env,再用真实 git + GIT_CONFIG_GLOBAL 指向模拟的「用户全局
// 配置」验证该 env 的效果(本机需 git ≥2.32;POSIX shell 脚本,Windows 跳过)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

const spawnEnvs: NodeJS.ProcessEnv[] = [];
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    return true;
  }
}
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: (_cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    spawnEnvs.push(opts.env);
    const c = new FakeChild();
    queueMicrotask(() => c.emit('exit', 1, null));
    return c;
  },
}));

import { installFromGit } from '../services/plugins.service';

const { execFileSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');

let root: string;
beforeEach(async () => {
  spawnEnvs.length = 0;
  root = await mkdtemp(path.join(tmpdir(), 'plugin-git-install-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

/** runGit 实际传给 git 子进程的 env。 */
async function runGitEnv(): Promise<NodeJS.ProcessEnv> {
  await installFromGit('https://example.com/p.git', path.join(root, 'plugins')).catch(() => undefined);
  expect(spawnEnvs.length).toBeGreaterThan(0);
  return spawnEnvs[spawnEnvs.length - 1]!;
}

/** 与用户本机配置隔离的 git env(仅用于搭建 fixture)。 */
function isolatedEnv(globalConfig: string): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig };
}

async function makeScript(name: string, marker: string, body: string): Promise<string> {
  const p = path.join(root, name);
  await writeFile(p, `#!/bin/sh\ntouch "${marker}"\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

describe.skipIf(process.platform === 'win32')('插件 git 安装不受用户全局 filter.lfs.* 驱动', () => {
  let src: string;
  let userGlobal: string;
  let marker: string;

  beforeEach(async () => {
    const empty = path.join(root, 'empty.gitconfig');
    await writeFile(empty, '');
    src = path.join(root, 'src');
    execFileSync('git', ['init', '-q', src], { env: isolatedEnv(empty), stdio: 'ignore' });
    const git = (args: string[]) => execFileSync('git', args, { cwd: src, env: isolatedEnv(empty), stdio: 'ignore' });
    await writeFile(path.join(src, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    await writeFile(path.join(src, 'a.bin'), 'payload\n');
    git(['add', '.']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);

    // 模拟用户全局配置(`git lfs install` 写入的形态),驱动换成会留下标记的脚本
    marker = path.join(root, 'LFS_RAN');
    const smudge = await makeScript('smudge.sh', marker, 'cat');
    const proc = await makeScript('process.sh', marker, 'exit 1');
    userGlobal = path.join(root, 'user.gitconfig');
    await writeFile(
      userGlobal,
      `[filter "lfs"]\n\tsmudge = ${smudge}\n\tprocess = ${proc}\n\trequired = true\n`,
    );
  });

  function clone(env: NodeJS.ProcessEnv, dst: string): void {
    execFileSync('git', ['clone', '-q', src, dst], {
      env: { ...env, GIT_CONFIG_GLOBAL: userGlobal, GIT_ALLOW_PROTOCOL: 'file' },
      stdio: 'ignore',
    });
  }

  it('前提:不加防护时 clone 检出会执行全局 filter.lfs 驱动', () => {
    try {
      clone({ ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, path.join(root, 'plain'));
    } catch {
      // process 驱动 exit 1 + required=true 会让 clone 失败;此处只关心驱动被执行
    }
    expect(existsSync(marker)).toBe(true);
  });

  it('runGit 的 env:设 GIT_LFS_SKIP_SMUDGE=1,clone 检出不执行 filter.lfs 驱动且照常成功', async () => {
    const env = await runGitEnv();
    expect(env.GIT_LFS_SKIP_SMUDGE).toBe('1');
    const dst = path.join(root, 'hardened');
    clone(env, dst);
    expect(existsSync(marker)).toBe(false);
    expect(await readFile(path.join(dst, 'a.bin'), 'utf8')).toBe('payload\n');
  });
});
