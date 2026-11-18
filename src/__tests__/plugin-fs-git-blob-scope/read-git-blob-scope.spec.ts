// 安全:readGitBlob 的 gitdir / commondir / 对象目录都必须在插件的只读 scope 内。行为见同目录 README。
// 用真实 git 仓库,经 plugin-fs IPC handler(含真实 PathScopeRegistry)验证三条越权路径 + 正常路径。
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { readGitBlob, registerPluginFsHandlers } from '../../../electron/main/services/plugin-fs.service';
import { stripGitRepoRedirectEnv } from '../../../electron/main/lib/child-spawn-hardening';
import { isValidGitBlobSha } from '../../../electron/shared/fs-limits';
import { ScopeError } from '../../plugins/types';
import { StubIpcMain, makeFakeEvent } from '../sdk-contract/integration/make-stub-ipc';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') } }));

const PLUGIN = 'plugin.git';
const SECRET = 'API_KEY=victim-secret\n';
const OUT_OF_SCOPE = /git repository not found within granted scope/;

let root: string;
let victim: string;
let secretSha: string;
let ipc: StubIpcMain;
let scopes: PathScopeRegistry;
let correlator: ScopeRequestCorrelator;
let token: string;
const event = makeFakeEvent({ id: 1 });

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

/** 在 dir 建仓库并写入一个 blob,返回其 sha。 */
async function initRepoWithBlob(dir: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-q']);
  await writeFile(join(dir, 'blob-src'), content);
  return git(dir, ['hash-object', '-w', 'blob-src']).trim();
}

function readBlob(repoDir: string, sha: string): Promise<Uint8Array> {
  return ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.READ_GIT_BLOB, token, repoDir, sha) as Promise<Uint8Array>;
}

async function readBlobText(repoDir: string, sha: string): Promise<string> {
  return Buffer.from(await readBlob(repoDir, sha)).toString();
}

async function expectScopeDenied(p: Promise<unknown>, message: RegExp = OUT_OF_SCOPE): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ScopeError);
  expect((err as Error).message).toMatch(message);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'git-blob-scope-')));
  victim = join(root, 'victim');
  secretSha = await initRepoWithBlob(victim, SECRET);
  ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  scopes = new PathScopeRegistry(identity);
  correlator = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
  registerPluginFsHandlers(ipc as never, {
    identityRegistry: identity,
    pathScopeRegistry: scopes,
    correlator,
    webContentsForSender: () => null,
  });
  token = ((await ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.REGISTER_PLUGIN, PLUGIN)) as { token: string }).token;
});

afterEach(async () => {
  correlator.dispose();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('readGitBlob:对象库必须在已授 scope 内', () => {
  it('前提:裸 git 从仓库子目录向上发现,能读到该 blob', async () => {
    await mkdir(join(victim, 'docs'));
    expect(git(join(victim, 'docs'), ['cat-file', 'blob', secretSha])).toBe(SECRET);
  });

  it('正常:整个仓库在 scope 内 → 从仓库根与子目录都能读', async () => {
    await mkdir(join(victim, 'docs'));
    scopes.grant(PLUGIN, [{ path: victim, mode: 'r' }]);
    expect(await readBlobText(victim, secretSha)).toBe(SECRET);
    expect(await readBlobText(join(victim, 'docs'), secretSha)).toBe(SECRET);
  });

  it('路径 1 向上发现:只授 repo/docs → 读不到 repo/.git 的对象', async () => {
    await mkdir(join(victim, 'docs'));
    scopes.grant(PLUGIN, [{ path: join(victim, 'docs'), mode: 'r' }]);
    await expectScopeDenied(readBlob(join(victim, 'docs'), secretSha));
  });

  it('路径 2 gitfile 重定向:scope 内写 .git 指向 scope 外仓库 → 拒', async () => {
    const scope = join(root, 'scope');
    await mkdir(scope);
    scopes.grant(PLUGIN, [{ path: scope, mode: 'rw' }]);
    await ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.WRITE_FILE,
      token,
      join(scope, '.git'),
      `gitdir: ${join(victim, '.git')}\n`,
    );
    await expectScopeDenied(readBlob(scope, secretSha));
  });

  it('路径 3 alternates:scope 内仓库的 objects/info/alternates 指向 scope 外对象目录 → 拒', async () => {
    const scope = join(root, 'scope');
    const ownSha = await initRepoWithBlob(scope, 'own');
    scopes.grant(PLUGIN, [{ path: scope, mode: 'rw' }]);
    expect(await readBlobText(scope, ownSha)).toBe('own');
    await ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.MKDIR, token, join(scope, '.git', 'objects', 'info'), {
      recursive: true,
    });
    await ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.WRITE_FILE,
      token,
      join(scope, '.git', 'objects', 'info', 'alternates'),
      `${join(victim, '.git', 'objects')}\n`,
    );
    await expectScopeDenied(readBlob(scope, secretSha), /alternates/);
    // 带 alternates 的对象库整体拒绝,不逐项判定。
    await expectScopeDenied(readBlob(scope, ownSha), /alternates/);
  });

  it('objects 目录是指向 scope 外的符号链接 → 拒', async () => {
    const scope = join(root, 'scope');
    await initRepoWithBlob(scope, 'own');
    await rename(join(scope, '.git', 'objects'), join(scope, '.git', 'objects.bak'));
    await symlink(join(victim, '.git', 'objects'), join(scope, '.git', 'objects'));
    scopes.grant(PLUGIN, [{ path: scope, mode: 'r' }]);
    await expectScopeDenied(readBlob(scope, secretSha));
  });

  it('对象扇出目录是指向 scope 外的符号链接 → 拒', async () => {
    const scope = join(root, 'scope');
    await initRepoWithBlob(scope, 'own');
    const fanout = secretSha.slice(0, 2);
    await symlink(join(victim, '.git', 'objects', fanout), join(scope, '.git', 'objects', fanout));
    scopes.grant(PLUGIN, [{ path: scope, mode: 'r' }]);
    await expectScopeDenied(readBlob(scope, secretSha));
  });

  // git 内部把 hex 转小写再找对象;校验若按原样的大写前缀去 lstat 扇出目录,大小写敏感文件系统上 objects/AB 不存在
  // (跳过校验)而 git 实际读的 objects/ab 是外链 → 读到 scope 外对象。入口统一转小写,校验与 git 看同一个名字。
  describe('大写 sha', () => {
    /** 建一个 sha 前两位含字母的 blob(大小写才有区别)。 */
    async function blobWithLetterFanout(dir: string): Promise<{ sha: string; content: string }> {
      for (let i = 0; ; i += 1) {
        const content = `own-${i}\n`;
        const sha = await initRepoWithBlob(dir, content);
        if (/[a-f]/.test(sha.slice(0, 2))) return { sha, content };
      }
    }

    it('校验的是小写扇出目录 / 对象文件路径(与 git 实际读取的一致),并照常读到内容', async () => {
      const scope = join(root, 'scope');
      const { sha, content } = await blobWithLetterFanout(scope);
      scopes.grant(PLUGIN, [{ path: scope, mode: 'r' }]);
      const check = vi.spyOn(scopes, 'check');
      expect(await readBlobText(scope, sha.toUpperCase())).toBe(content);
      const checked = check.mock.calls.map((c) => String(c[3]));
      const objects = join(scope, '.git', 'objects');
      expect(checked).toContain(join(objects, sha.slice(0, 2)));
      expect(checked).toContain(join(objects, sha.slice(0, 2), sha.slice(2)));
      expect(checked).not.toContain(join(objects, sha.slice(0, 2).toUpperCase()));
    });

    it('大写 sha + 小写扇出目录是指向 scope 外的符号链接 → 拒', async () => {
      // 让受害仓库里的秘密 blob 的扇出前缀含字母。
      let upper = secretSha;
      for (let i = 0; !/[a-f]/.test(upper.slice(0, 2)); i += 1) {
        await writeFile(join(victim, 'blob-src'), `${SECRET}#${i}\n`);
        upper = git(victim, ['hash-object', '-w', 'blob-src']).trim();
      }
      const scope = join(root, 'scope');
      await initRepoWithBlob(scope, 'own');
      const fanout = upper.slice(0, 2);
      await rm(join(scope, '.git', 'objects', fanout), { recursive: true, force: true });
      await symlink(join(victim, '.git', 'objects', fanout), join(scope, '.git', 'objects', fanout));
      scopes.grant(PLUGIN, [{ path: scope, mode: 'r' }]);
      await expectScopeDenied(readBlob(scope, upper.toUpperCase()));
    });
  });

  // 有 rw scope 的插件可在 scope 内仓库写 refs/replace/<请求的 sha> 指向目标 OID T,并让 objects/<T 前两位>
  // 成为指向 scope 外对象目录的符号链接(SDK 的 cp 按链接复制,可把工作区里已有的外链搬进去)。扇出校验只覆盖
  // 被请求 sha 的前两位;git 默认跟随 replace-ref,cat-file 就读到未校验扇出里的 scope 外对象。
  it('replace-ref 指向经外链扇出可达的 scope 外对象 → 返回原对象,不跟随 replace-ref', async () => {
    const scope = join(root, 'scope');
    const ownSha = await initRepoWithBlob(scope, 'own');
    const targetFanout = secretSha.slice(0, 2);
    expect(ownSha.slice(0, 2)).not.toBe(targetFanout); // 否则被既有的扇出校验拦下,测不到 replace-ref
    await symlink(join(victim, '.git', 'objects', targetFanout), join(scope, '.git', 'objects', targetFanout));
    await mkdir(join(scope, '.git', 'refs', 'replace'), { recursive: true });
    await writeFile(join(scope, '.git', 'refs', 'replace', ownSha), `${secretSha}\n`);
    // 前提:裸 git 跟随 replace-ref,读请求的 sha 得到的是 scope 外对象的内容。
    expect(git(scope, ['cat-file', 'blob', ownSha])).toBe(SECRET);

    scopes.grant(PLUGIN, [{ path: scope, mode: 'r' }]);
    expect(await readBlobText(scope, ownSha)).toBe('own');
  });

  it('pack 目录里有符号链接 → 拒', async () => {
    const scope = join(root, 'scope');
    const ownSha = await initRepoWithBlob(scope, 'own');
    await symlink(join(victim, 'blob-src'), join(scope, '.git', 'objects', 'pack', 'pack-x.pack'));
    scopes.grant(PLUGIN, [{ path: scope, mode: 'r' }]);
    await expectScopeDenied(readBlob(scope, ownSha));
  });

  it('linked worktree 的主仓(commondir)在 scope 外 → 拒', async () => {
    git(victim, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const wt = join(root, 'wt');
    git(victim, ['worktree', 'add', '-q', wt]);
    scopes.grant(PLUGIN, [{ path: wt, mode: 'r' }]);
    await expectScopeDenied(readBlob(wt, secretSha));
  });

  it('不是 git 仓库 → 与 scope 外同一条错误', async () => {
    const scope = join(root, 'plain');
    await mkdir(scope);
    scopes.grant(PLUGIN, [{ path: scope, mode: 'r' }]);
    // 测试临时目录的上级可能恰在某个仓库内(向上发现),两种情况都必须是同一条错误。
    await expectScopeDenied(readBlob(scope, secretSha));
  });

  it('宿主 env 的 GIT_DIR / GIT_ALTERNATE_OBJECT_DIRECTORIES 不传给 git', async () => {
    const scope = join(root, 'scope');
    const ownSha = await initRepoWithBlob(scope, 'own');
    scopes.grant(PLUGIN, [{ path: scope, mode: 'r' }]);
    vi.stubEnv('GIT_ALTERNATE_OBJECT_DIRECTORIES', join(victim, '.git', 'objects'));
    await expect(readBlob(scope, secretSha)).rejects.toThrow(/git cat-file failed/);
    vi.unstubAllEnvs();
    vi.stubEnv('GIT_DIR', join(victim, '.git'));
    await expect(readBlob(scope, secretSha)).rejects.toThrow(/git cat-file failed/);
    expect(await readBlobText(scope, ownSha)).toBe('own');
  });

  it('pin:git 只读已校验的 gitdir / 对象目录,不再从 cwd 自行发现', async () => {
    const elsewhere = join(root, 'elsewhere');
    await initRepoWithBlob(elsewhere, 'other');
    const pin = { gitDir: join(victim, '.git'), commonDir: join(victim, '.git'), objectDir: join(victim, '.git', 'objects') };
    expect(Buffer.from(await readGitBlob(elsewhere, secretSha, { pin })).toString()).toBe(SECRET);
  });

  it('缩写 sha → 拒(不做唯一前缀解析)', async () => {
    scopes.grant(PLUGIN, [{ path: victim, mode: 'r' }]);
    await expectScopeDenied(readBlob(victim, secretSha.slice(0, 8)), /invalid git blob sha/);
  });

  it('旧版 git(rev-parse 不认 --path-format,原样回显)→ fail-closed', async () => {
    scopes.grant(PLUGIN, [{ path: victim, mode: 'r' }]);
    const bin = join(root, 'bin');
    await mkdir(bin);
    // 模拟 git < 2.31:rev-parse 把不认识的选项原样输出,--git-common-dir 给相对路径;cat-file 交给真 git。
    const realGit = execFileSync('/bin/sh', ['-c', 'command -v git']).toString().trim();
    await writeFile(
      join(bin, 'git'),
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = rev-parse ]; then echo "--path-format=absolute"; echo "$PWD/.git"; echo ".git"; exit 0; fi; done\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    await expectScopeDenied(readBlob(victim, secretSha));
  });
});

describe('stripGitRepoRedirectEnv', () => {
  it('剥离重定向仓库 / 对象库 / 工作树的 GIT_* 变量,其余保留', () => {
    const out = stripGitRepoRedirectEnv({
      GIT_DIR: 'a',
      GIT_WORK_TREE: 'a',
      GIT_OBJECT_DIRECTORY: 'a',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: 'a',
      GIT_INDEX_FILE: 'a',
      GIT_COMMON_DIR: 'a',
      GIT_NAMESPACE: 'a',
      GIT_CEILING_DIRECTORIES: 'a',
      GIT_AUTHOR_NAME: 'keep',
      PATH: '/bin',
    });
    expect(out).toEqual({ GIT_AUTHOR_NAME: 'keep', PATH: '/bin' });
  });

  it('Windows:键名大小写不敏感', () => {
    expect(stripGitRepoRedirectEnv({ Git_Dir: 'a', Path: 'p' }, 'win32')).toEqual({ Path: 'p' });
  });
});

describe('isValidGitBlobSha:只认完整 sha', () => {
  it('40 / 64 位 hex 通过;其它长度拒绝', () => {
    expect(isValidGitBlobSha('a'.repeat(40))).toBe(true);
    expect(isValidGitBlobSha('A'.repeat(64))).toBe(true);
    for (const n of [4, 8, 39, 41, 63, 65]) expect(isValidGitBlobSha('a'.repeat(n))).toBe(false);
    expect(isValidGitBlobSha('g'.repeat(40))).toBe(false);
  });
});
