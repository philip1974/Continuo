// BDD: explorer-git-decorations / main 侧 git 状态:XY → 装饰、porcelain -z 解析、真实仓库查询、静默失败、只读 env、并发与合并、根取自窗口
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifyXY,
  createGitStatusService,
  execGit,
  gitStatusEnv,
  makeGitStatusHandler,
  parsePorcelainZ,
  queryGitStatus,
  type GitExec,
} from '../../../electron/main/services/git-status.service';
import { GIT_STATUS_STALE, type GitStatusSnapshot } from '../../../electron/shared/git-status';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('XY 状态码 → 装饰', () => {
  it.each([
    ['??', 'untracked', 'U'],
    ['!!', 'ignored', ''],
    [' M', 'modified', 'M'],
    ['M ', 'modified', 'M'],
    ['MM', 'modified', 'M'],
    [' T', 'modified', 'T'],
    ['A ', 'added', 'A'],
    ['AM', 'modified', 'M'],
    [' A', 'added', 'A'],
    ['D ', 'deleted', 'D'],
    [' D', 'deleted', 'D'],
    ['R ', 'renamed', 'R'],
    ['C ', 'renamed', 'C'],
    ['UU', 'conflict', '!'],
    ['AA', 'conflict', '!'],
    ['DD', 'conflict', '!'],
    ['AU', 'conflict', '!'],
    ['UD', 'conflict', '!'],
    ['UA', 'conflict', '!'],
    ['DU', 'conflict', '!'],
  ])('%s → %s %s', (xy, kind, letter) => {
    expect(classifyXY(xy)).toMatchObject({ kind, letter });
  });

  it('无法识别 → null', () => {
    expect(classifyXY('  ')).toBeNull();
    expect(classifyXY('XY')).toBeNull();
  });
});

describe('porcelain v1 -z 解析', () => {
  it('去工作区前缀、丢弃根外条目;重命名只取新路径', () => {
    const out = [' M sub/a.ts', '?? sub/new.ts', 'R  sub/b2.ts', 'sub/b.ts', ' M other/x.ts', '!! sub/dist/', ''].join('\0');
    expect(parsePorcelainZ(out, 'sub/')).toEqual([
      ['a.ts', 'modified', 'M'],
      ['new.ts', 'untracked', 'U'],
      ['b2.ts', 'renamed', 'R'],
      ['dist/', 'ignored', ''],
    ]);
  });

  it('同一路径多条:按 index < untracked < working tree < merge 取后者', () => {
    expect(parsePorcelainZ(['D  f.txt', '?? f.txt', ''].join('\0'), '')).toEqual([['f.txt', 'untracked', 'U']]);
  });

  it('工作区根本身在未跟踪 / 忽略目录内 → 记为 \'\'', () => {
    expect(parsePorcelainZ('!! build/\0', 'build/out/')).toEqual([['', 'ignored', '']]);
  });
});

describe.skipIf(!hasGit())('真实仓库', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      stdio: 'ignore',
    });
  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'git-deco-'));
    git('init', '-q');
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src/a.ts'), 'a\n');
    writeFileSync(path.join(repo, 'src/old.ts'), 'old\n');
    writeFileSync(path.join(repo, '.gitignore'), 'dist/\n*.log\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('修改 / 未跟踪 / 新增 / 重命名 / 忽略文件 / 忽略目录 / 未跟踪目录', async () => {
    writeFileSync(path.join(repo, 'src/a.ts'), 'a2\n');
    writeFileSync(path.join(repo, 'src/new.ts'), 'n\n');
    writeFileSync(path.join(repo, 'staged.ts'), 's\n');
    git('add', 'staged.ts');
    git('mv', 'src/old.ts', 'src/renamed.ts');
    writeFileSync(path.join(repo, 'debug.log'), 'x');
    mkdirSync(path.join(repo, 'dist'));
    writeFileSync(path.join(repo, 'dist/out.js'), 'x');
    mkdirSync(path.join(repo, 'fresh'));
    writeFileSync(path.join(repo, 'fresh/f.ts'), 'x');
    const snap = await queryGitStatus(repo);
    expect(snap?.root).toBe(repo);
    expect(new Map(snap!.entries.map(([p, k, l]) => [p, `${k}:${l}`]))).toEqual(
      new Map([
        ['src/a.ts', 'modified:M'],
        ['src/new.ts', 'untracked:U'],
        ['staged.ts', 'added:A'],
        ['src/renamed.ts', 'renamed:R'],
        ['debug.log', 'ignored:'],
        ['dist/', 'ignored:'],
        ['fresh/', 'untracked:U'],
      ]),
    );
  });

  it('工作区是仓库子目录:路径相对工作区根,根外变化不出现', async () => {
    writeFileSync(path.join(repo, 'src/a.ts'), 'a2\n');
    writeFileSync(path.join(repo, 'top.ts'), 'x');
    const snap = await queryGitStatus(path.join(repo, 'src'));
    expect(snap?.entries).toEqual([['a.ts', 'modified', 'M']]);
  });

  it('不写 index、不留 index.lock(GIT_OPTIONAL_LOCKS=0)', async () => {
    writeFileSync(path.join(repo, 'src/a.ts'), 'a2\n');
    const index = path.join(repo, '.git/index');
    const before = statSync(index).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await queryGitStatus(repo);
    expect(existsSync(path.join(repo, '.git/index.lock'))).toBe(false);
    expect(statSync(index).mtimeMs).toBe(before);
  });

  it('不是仓库 → null', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'git-deco-plain-'));
    try {
      expect(await queryGitStatus(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('静默失败', () => {
  it('git 不存在 / rev-parse 失败 → null', async () => {
    const exec: GitExec = () => Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
    expect(await queryGitStatus('/w', exec)).toBeNull();
  });

  it('不在工作树内(rev-parse 输出非 true)→ null,不再跑 status', async () => {
    const calls: string[] = [];
    const exec: GitExec = async (args) => {
      calls.push(args[0]!);
      return 'false\n';
    };
    expect(await queryGitStatus('/w', exec)).toBeNull();
    expect(calls).toEqual(['rev-parse']);
  });

  it('status 失败(超时 / 超限)→ null', async () => {
    const exec: GitExec = async (args) => {
      if (args[0] === 'rev-parse') return 'true\n\n';
      throw new Error('killed');
    };
    expect(await queryGitStatus('/w', exec)).toBeNull();
  });
});

describe('只读、加固的 git 环境', () => {
  it('GIT_OPTIONAL_LOCKS=0、强制 core.fsmonitor=false、禁传输、剥离宿主机密与 GIT_DIR', () => {
    const saved = { ...process.env };
    process.env.CONTINUO_MCP_TOKEN = 'secret';
    process.env.GIT_DIR = '/elsewhere/.git';
    try {
      const env = gitStatusEnv();
      expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(env.GIT_ALLOW_PROTOCOL).toBe('');
      expect(env.CONTINUO_MCP_TOKEN).toBeUndefined();
      expect(env.GIT_DIR).toBeUndefined();
      const n = Number(env.GIT_CONFIG_COUNT);
      const keys = Array.from({ length: n }, (_, i) => `${env[`GIT_CONFIG_KEY_${i}`]}=${env[`GIT_CONFIG_VALUE_${i}`]}`);
      expect(keys).toContain('core.fsmonitor=false');
    } finally {
      process.env = saved;
    }
  });

  it.skipIf(!hasGit() || process.platform === 'win32')('参数数组形式执行,不经 shell(参数里的 shell 元字符原样交给 git)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'git-deco-sh-'));
    const marker = path.join(dir, 'pwned');
    try {
      await execGit(['--version', `$(touch ${marker})`, `;touch ${marker}`], dir);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('并发与合并', () => {
  function controlledExec() {
    const pending: { args: readonly string[]; cwd: string; resolve: (s: string) => void }[] = [];
    const exec: GitExec = (args, cwd) => new Promise((resolve) => pending.push({ args, cwd, resolve }));
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return { exec, pending, flush };
  }

  it('同一根:一次在跑 + 一次排队,排队期间的请求合并', async () => {
    const { exec, pending, flush } = controlledExec();
    const svc = createGitStatusService(exec, 2);
    const a = svc.status('/w');
    await flush();
    const b = svc.status('/w');
    const c = svc.status('/w');
    expect(b).toBe(c);
    expect(pending).toHaveLength(1); // 第二次在等第一次
    pending[0]!.resolve('true\n\n');
    await flush();
    pending[1]!.resolve(' M a\0');
    expect((await a)?.entries).toEqual([['a', 'modified', 'M']]);
    await flush();
    expect(pending).toHaveLength(3); // 排队那次开始
    pending[2]!.resolve('true\n\n');
    await flush();
    pending[3]!.resolve('?? b\0');
    expect((await b)?.entries).toEqual([['b', 'untracked', 'U']]);
  });

  it('全局并发上限:超出的根等待空位', async () => {
    const { exec, pending, flush } = controlledExec();
    const svc = createGitStatusService(exec, 1);
    const a = svc.status('/a');
    const b = svc.status('/b');
    await flush();
    expect(pending.map((p) => p.cwd)).toEqual(['/a']);
    pending[0]!.resolve('false\n');
    expect(await a).toBeNull();
    await flush();
    expect(pending.map((p) => p.cwd)).toEqual(['/a', '/b']);
    pending[1]!.resolve('false\n');
    expect(await b).toBeNull();
  });
});

describe('IPC 处理:根取自发送窗口', () => {
  it('用窗口登记的工作区根作 cwd', async () => {
    const roots: string[] = [];
    const snap: GitStatusSnapshot = { root: '/ws', entries: [] };
    const handle = makeGitStatusHandler(
      {
        status: async (root) => {
          roots.push(root);
          return snap;
        },
      },
      (id) => (id === 1 ? '/ws' : null),
    );
    expect(await handle({ id: 1 }, '/ws')).toBe(snap);
    expect(roots).toEqual(['/ws']);
  });

  it('renderer 期望的根与本窗口登记的根不符(换根后 notify-root 尚未到达)→ stale,不跑 git;cwd 只用登记根', async () => {
    const roots: string[] = [];
    const handle = makeGitStatusHandler(
      {
        status: async (root) => {
          roots.push(root);
          return { root, entries: [] };
        },
      },
      (id) => (id === 1 ? '/old' : null),
    );
    expect(await handle({ id: 1 }, '/new')).toEqual(GIT_STATUS_STALE);
    expect(await handle({ id: 2 }, '/new')).toEqual(GIT_STATUS_STALE); // 从「未打开文件夹」首次打开:登记还没到
    expect(roots).toEqual([]);
  });
});
