// 安全(纵深):readGitBlob 跑 `git cat-file blob <sha>`。恶意 workspace 的 `.git/config` 设
// `extensions.partialClone=origin` + `remote.origin.uploadpack=<cmd>` 时,缺失的 blob 会触发惰性拉取
//(lazy fetch),git 以本地传输启动 uploadpack 指定的命令 → 任意命令执行。readGitBlob 追加
// `-c protocol.allow=never`(所有传输协议一律拒绝,低版本 git 也认)+ env GIT_NO_LAZY_FETCH=1(git ≥2.45)。
// 用真实 git 仓库 + 会创建标记文件的 uploadpack 脚本验证。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readGitBlob } from '../services/plugin-fs.service';

let root: string;
let repo: string;
let marker: string;
const MISSING_SHA = '1234567890123456789012345678901234567890';

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'lazy-fetch-rce-'));
  repo = path.join(root, 'repo');
  marker = path.join(root, 'PWNED');
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  const evil = path.join(root, 'evil-uploadpack.sh');
  await writeFile(evil, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
  await chmod(evil, 0o755);
  git(['config', 'core.repositoryformatversion', '1']);
  git(['config', 'extensions.partialClone', 'origin']);
  git(['config', 'remote.origin.url', path.join(root, 'nowhere')]);
  git(['config', 'remote.origin.uploadpack', evil]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe.skipIf(process.platform === 'win32')('readGitBlob 不触发 partial clone 惰性拉取', () => {
  it('前提:不加防护时 cat-file 缺失 blob 会执行仓库配置的 uploadpack 命令', () => {
    try {
      execFileSync('git', ['cat-file', 'blob', MISSING_SHA], { cwd: repo, stdio: 'ignore' });
    } catch {
      // 拉取失败 → 非零退出,预期
    }
    expect(existsSync(marker)).toBe(true);
  });

  it('readGitBlob 读缺失 blob:reject 且不执行 uploadpack 命令', async () => {
    await expect(readGitBlob(repo, MISSING_SHA)).rejects.toThrow(/git cat-file failed/);
    expect(existsSync(marker)).toBe(false);
  });

  it('readGitBlob 读已存在的 blob 不受影响', async () => {
    await writeFile(path.join(repo, 'a.txt'), 'hello');
    const sha = execFileSync('git', ['hash-object', '-w', 'a.txt'], { cwd: repo }).toString().trim();
    const bytes = await readGitBlob(repo, sha);
    expect(Buffer.from(bytes).toString('utf8')).toBe('hello');
  });
});
