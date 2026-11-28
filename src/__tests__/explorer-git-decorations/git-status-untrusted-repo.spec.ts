// BDD: explorer-git-decorations / 打开不可信文件夹:宿主自动跑的 git 状态查询不执行仓库自带配置里的外部程序
// (filter clean / process、子模块里的 filter、hook)。用真实 git + 只写标记文件的无害探针脚本验证。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { queryGitStatus, repoFilterOverrides } from '../../../electron/main/services/git-status.service';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('repoFilterOverrides:只置空仓库作用域定义的 filter 驱动', () => {
  it('local / worktree 的驱动名(区分大小写,可含 . 与 =)逐个置空;global / system 的不动', () => {
    const out = [
      'global', 'filter.lfs.clean',
      'local', 'filter.Evil.clean',
      'local', 'filter.a.b=c.process',
      'worktree', 'filter.wt.smudge',
      'local', 'core.bare',
      '',
    ].join('\0');
    const cfg = new Map(repoFilterOverrides(out));
    for (const name of ['Evil', 'a.b=c', 'wt']) {
      expect(cfg.get(`filter.${name}.clean`)).toBe('');
      expect(cfg.get(`filter.${name}.smudge`)).toBe('');
      expect(cfg.get(`filter.${name}.process`)).toBe('');
      expect(cfg.get(`filter.${name}.required`)).toBe('false');
    }
    expect([...cfg.keys()].some((k) => k.includes('lfs'))).toBe(false);
    expect(cfg.size).toBe(12);
  });
});

describe.skipIf(!hasGit() || process.platform === 'win32')('真实仓库:自带配置的外部程序不被执行', () => {
  let dir: string;
  let repo: string;
  let marker: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', ...args], {
      cwd,
      stdio: 'ignore',
    });
  /** 被执行就写标记文件的探针;作为 filter 时原样回传内容。 */
  const probe = (name: string): string => {
    const p = path.join(dir, `${name}.sh`);
    writeFileSync(p, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    chmodSync(p, 0o755);
    return p;
  };
  /** 让已跟踪文件 stat 变脏(内容不变):status 需重新读内容比较,才会走 clean 过滤器。 */
  const touchOld = (p: string) => utimesSync(p, new Date(2001, 0, 1), new Date(2001, 0, 1));

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'git-untrusted-'));
    repo = path.join(dir, 'proj');
    marker = path.join(dir, 'EXECUTED');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
    writeFileSync(path.join(repo, 'b.md'), 'hi\n');
    writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=evil\n*.md filter=Ev=il.x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('前提:不加防护的 git status 会执行仓库配置的 clean 过滤器', () => {
    git(repo, 'config', 'filter.evil.clean', probe('clean'));
    touchOld(path.join(repo, 'a.txt'));
    execFileSync('git', ['status', '--porcelain'], { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    expect(existsSync(marker)).toBe(true);
  });

  it('filter.<名>.clean / process(名字含 = 与 .)不执行,status 仍返回结果', async () => {
    git(repo, 'config', 'filter.evil.clean', probe('clean'));
    git(repo, 'config', 'filter.Ev=il.x.process', probe('process'));
    git(repo, 'config', 'filter.Ev=il.x.required', 'true');
    touchOld(path.join(repo, 'a.txt'));
    touchOld(path.join(repo, 'b.md'));
    writeFileSync(path.join(repo, 'new.ts'), 'x');
    const snap = await queryGitStatus(repo);
    expect(existsSync(marker)).toBe(false);
    expect(snap?.entries).toContainEqual(['new.ts', 'untracked', 'U']);
  });

  it('经 include.path 引入的 filter 定义同样置空', async () => {
    const inc = path.join(dir, 'inc.cfg');
    writeFileSync(inc, `[filter "evil"]\n\tclean = ${probe('clean')}\n`);
    git(repo, 'config', 'include.path', inc);
    touchOld(path.join(repo, 'a.txt'));
    expect(await queryGitStatus(repo)).not.toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it('子模块自己的 .git/config 里的 filter 不执行(不进子模块跑 status)', async () => {
    const sub = path.join(dir, 'sub');
    mkdirSync(sub);
    git(sub, 'init', '-q');
    writeFileSync(path.join(sub, 's.txt'), 's\n');
    writeFileSync(path.join(sub, '.gitattributes'), '*.txt filter=sev\n');
    git(sub, 'add', '.');
    git(sub, 'commit', '-q', '-m', 's');
    git(repo, 'submodule', 'add', '-q', sub, 'sm');
    git(repo, 'commit', '-q', '-m', 'sm');
    git(path.join(repo, 'sm'), 'config', 'filter.sev.clean', probe('sub-clean'));
    touchOld(path.join(repo, 'sm/s.txt'));
    expect(await queryGitStatus(repo)).not.toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it('仓库 hook(.git/hooks 与 core.hooksPath)不执行', async () => {
    const hooks = path.join(dir, 'hooks');
    mkdirSync(hooks);
    for (const h of ['post-index-change', 'post-checkout', 'pre-commit']) {
      writeFileSync(path.join(hooks, h), `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(path.join(hooks, h), 0o755);
      writeFileSync(path.join(repo, '.git/hooks', h), `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(path.join(repo, '.git/hooks', h), 0o755);
    }
    git(repo, 'config', 'core.hooksPath', hooks);
    touchOld(path.join(repo, 'a.txt'));
    expect(await queryGitStatus(repo)).not.toBeNull();
    expect(existsSync(marker)).toBe(false);
  });
});
