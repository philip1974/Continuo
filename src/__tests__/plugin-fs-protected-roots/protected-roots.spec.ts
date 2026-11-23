// 安全:应用自身的数据目录(userData,含另一发行形态的)与安装目录是「受保护根」—— 无论插件拿到多宽的
// path-scope(如 `~`),其下任何路径都不可读写。行为见同目录 README。
// 经真实 plugin-fs IPC handler + 真实 PathScopeRegistry + 真实临时目录验证。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, promises as fsp, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { pluginFsIdentityEpoch, registerPluginFsHandlers } from '../../../electron/main/services/plugin-fs.service';
import { readPermissions, writePermissions } from '../../../electron/main/services/plugins.service';
import { StubIpcMain, makeFakeEvent } from '../sdk-contract/integration/make-stub-ipc';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') } }));

const PLUGIN = 'plugin.attacker';
const C = PLUGIN_FS_CHANNELS;
const DENIED = 'target not in any granted scope';

let root: string; // canonical
let home: string; // 用户授予 rw 的「home」
let appData: string;
let userData: string; // 本实例(dev 形态)
let otherUserData: string; // 另一发行形态(packaged)
let notYet: string; // 尚不存在的受保护根
let cfg: string;
let secrets: string; // 名字含 `s` 的受保护根(长 s 变体 `ſecrets` 在 APFS 上是同一个条目)
let nextSecrets: string; // 尚不存在、名字含 `s` 的受保护根
let viaLinkRoot: string; // 经符号链接 `SLib` 给出的受保护根:链接这个名字是其词法形的祖先
let lateRoot: string; // 启动时尚不存在、之后经符号链接 `later` 出现在别处的受保护根
let allRoots: string[];
const extraCorrelators: ScopeRequestCorrelator[] = [];
let pluginsDir: string;
let permFile: string;
let docs: string;
let ipc: StubIpcMain;
let scopes: PathScopeRegistry;
let correlator: ScopeRequestCorrelator;
let token: string;
let event: ReturnType<typeof makeFakeEvent>;
let permBefore: string;
// 整套攻击回归跑在生产接线下:受保护根 inode 判定的身份缓存接到 plugin-fs 锁的代际上(见 identity-cache.spec.ts)。
let identityCacheOff = false;
const identityCache = { getEpoch: (): number | null => (identityCacheOff ? null : pluginFsIdentityEpoch()) };

function call(channel: string, ...args: unknown[]): Promise<unknown> {
  return ipc.invokeWithEvent(event, channel, token, ...args);
}

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    const e = err as Error & { code?: string; details?: { reason?: string } };
    return JSON.stringify([e.name, e.code, e.message, e.details?.reason]);
  }
}

async function expectDenied(p: Promise<unknown>): Promise<void> {
  const o = await outcome(p);
  expect(o).toContain('ScopeError');
  expect(o).toContain(DENIED);
}

beforeEach(async () => {
  identityCacheOff = false;
  root = await realpath(await mkdtemp(join(tmpdir(), 'protected-roots-')));
  home = join(root, 'home');
  appData = join(home, 'Library', 'Application Support');
  userData = join(appData, 'Continuo Dev');
  otherUserData = join(appData, 'Continuo');
  notYet = join(home, 'NotYetInstalled');
  pluginsDir = join(userData, 'plugins');
  permFile = join(pluginsDir, '_permissions.json');
  docs = join(home, 'docs');
  await mkdir(join(pluginsDir, 'victim'), { recursive: true });
  await mkdir(join(otherUserData, 'plugins'), { recursive: true });
  await mkdir(docs, { recursive: true });
  await writePermissions(pluginsDir, {
    [PLUGIN]: { decisions: [{ permission: 'fs', granted: true, decidedAt: 1 }] },
  });
  permBefore = await readFile(permFile, 'utf-8');
  await writeFile(join(pluginsDir, '_plugin-path-scopes.json'), '{}');
  await writeFile(join(pluginsDir, 'victim', 'main.js'), 'module.exports = {};');
  await writeFile(join(pluginsDir, 'victim', 'data.json'), '{"token":"gho_secret"}');
  await writeFile(join(userData, 'explorer.json'), '{}');
  await writeFile(join(otherUserData, 'plugins', '_permissions.json'), '{}');
  await writeFile(join(docs, 'a.txt'), 'hello');
  cfg = join(home, 'cfg');
  secrets = join(cfg, 'Secrets');
  nextSecrets = join(cfg, 'NextSecrets');
  await mkdir(secrets, { recursive: true });
  await writeFile(join(secrets, 'key'), 'k');
  await mkdir(join(home, 'reallib', 'App'), { recursive: true });
  await symlink(join(home, 'reallib'), join(home, 'SLib'));
  viaLinkRoot = join(home, 'SLib', 'App');
  lateRoot = join(home, 'later', 'App');
  allRoots = [userData, otherUserData, notYet, secrets, nextSecrets, viaLinkRoot, lateRoot];

  event = makeFakeEvent({ id: 1, isDestroyed: () => false });
  ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  scopes = new PathScopeRegistry(identity, { protectedRoots: allRoots, identityCache });
  correlator = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
  registerPluginFsHandlers(ipc as never, {
    identityRegistry: identity,
    pathScopeRegistry: scopes,
    correlator,
  });
  token = ((await ipc.invokeWithEvent(event, C.REGISTER_PLUGIN, PLUGIN)) as { token: string }).token;
  scopes.grant(PLUGIN, [{ path: home, mode: 'rw' }]);
  event.sender.send.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// 另起一套 registry + handler(不同的 registry 选项 / 平台),同一批受保护根与 `home` rw scope。
async function extraStack(
  opts: { onDiskNameScanLimit?: number } = {},
): Promise<(channel: string, ...args: unknown[]) => Promise<unknown>> {
  const stubIpc = new StubIpcMain();
  const identity = new IdentityRegistry();
  const registry = new PathScopeRegistry(identity, { protectedRoots: allRoots, identityCache, ...opts });
  const c = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
  extraCorrelators.push(c);
  registerPluginFsHandlers(stubIpc as never, {
    identityRegistry: identity,
    pathScopeRegistry: registry,
    correlator: c,
  });
  const ev = makeFakeEvent({ id: 7, isDestroyed: () => false });
  const t = ((await stubIpc.invokeWithEvent(ev, C.REGISTER_PLUGIN, PLUGIN)) as { token: string }).token;
  registry.grant(PLUGIN, [{ path: home, mode: 'rw' }]);
  return (channel, ...args) => stubIpc.invokeWithEvent(ev, channel, t, ...args);
}

afterEach(async () => {
  correlator.dispose();
  for (const c of extraCorrelators.splice(0)) c.dispose();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

// 临时目录所在卷是否把长 s(U+017F)与 `s` 当同一个名字(APFS 默认如此;JS 的 toLowerCase 不这么折叠)。
const volumeFoldsLongS = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), 'fold-probe-'));
  try {
    writeFileSync(join(dir, 'Sx'), '');
    return existsSync(join(dir, 'ſx'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const longS = (p: string, from: string, to: string): string => {
  expect(p.includes(from)).toBe(true);
  return p.replace(from, to);
};

describe('端到端提权:持 `~` rw scope 的插件改写权限文件', () => {
  it('writeFile(_permissions.json) 给自己加 shell → 被拒,readPermissions 读不到被篡改的授权', async () => {
    const forged = JSON.stringify({
      [PLUGIN]: {
        decisions: [
          { permission: 'fs', granted: true, decidedAt: 1 },
          { permission: 'shell', granted: true, decidedAt: 2 },
        ],
      },
    });
    await expectDenied(call(C.WRITE_FILE, permFile, forged));
    const perms = await readPermissions(pluginsDir);
    const rec = perms[PLUGIN]!;
    const decisions = 'decisions' in rec ? rec.decisions : rec;
    expect(decisions.map((d) => d.permission)).toEqual(['fs']);
    expect(await readFile(permFile, 'utf-8')).toBe(permBefore);
  });

  it('改 _plugin-path-scopes.json / 另一插件的 main.js / 读它的 data.json → 全拒', async () => {
    await expectDenied(
      call(C.WRITE_FILE, join(pluginsDir, '_plugin-path-scopes.json'), '{"x":[{"path":"/","mode":"rw"}]}'),
    );
    await expectDenied(call(C.WRITE_FILE, join(pluginsDir, 'victim', 'main.js'), 'evil()'));
    await expectDenied(call(C.READ_FILE, join(pluginsDir, 'victim', 'data.json')));
    await expectDenied(call(C.READ_FILE, join(userData, 'explorer.json')));
    expect(await readFile(join(pluginsDir, '_plugin-path-scopes.json'), 'utf-8')).toBe('{}');
    expect(await readFile(join(pluginsDir, 'victim', 'main.js'), 'utf-8')).toBe('module.exports = {};');
  });
});

describe('受保护根之内:所有入口一律拒绝,文件不变', () => {
  it('readFile / stat / lstat / realpath / listDir / checkPath', async () => {
    await expectDenied(call(C.READ_FILE, permFile));
    await expectDenied(call(C.STAT, permFile));
    await expectDenied(call(C.LSTAT, permFile));
    await expectDenied(call(C.REALPATH, permFile));
    await expectDenied(call(C.LIST_DIR, pluginsDir));
    await expectDenied(call(C.LIST_DIR, userData)); // 根本身
    await expectDenied(call(C.STAT, userData));
    expect(await call(C.CHECK_PATH, permFile)).toBe(false);
    expect(await call(C.CHECK_PATH, userData)).toBe(false);
    expect(await call(C.READ_FOR_EDITOR, permFile)).toMatchObject({ ok: false, code: 'SCOPE_ERROR' });
  });

  it('rm / rename / mkdir / cp(源与目标)/ atomicReplace', async () => {
    await expectDenied(call(C.RM, permFile));
    await expectDenied(call(C.RM, pluginsDir, { recursive: true, force: true }));
    await expectDenied(call(C.RM, userData, { recursive: true, force: true }));
    await expectDenied(call(C.RENAME, permFile, join(pluginsDir, 'x.json')));
    await expectDenied(call(C.RENAME, join(pluginsDir, 'victim'), join(pluginsDir, 'victim2')));
    await expectDenied(call(C.MKDIR, join(pluginsDir, 'evil'), { recursive: true }));
    await expectDenied(call(C.CP, permFile, join(docs, 'stolen.json')));
    await expectDenied(call(C.CP, join(pluginsDir, 'victim'), join(docs, 'victim'), { recursive: true }));
    await expectDenied(call(C.CP, join(docs, 'a.txt'), join(pluginsDir, 'victim', 'evil.js')));
    await writeFile(join(pluginsDir, 'staging.json'), '{}'); // 即便 staging 已在其中(本不可能经 SDK 写入)
    await expectDenied(call(C.ATOMIC_REPLACE, join(pluginsDir, 'staging.json'), permFile, { overwrite: true }));
    expect(await readFile(permFile, 'utf-8')).toBe(permBefore);
    expect(existsSync(join(pluginsDir, 'victim', 'main.js'))).toBe(true);
    expect(existsSync(join(pluginsDir, 'evil'))).toBe(false);
    expect(existsSync(join(docs, 'stolen.json'))).toBe(false);
    expect(existsSync(join(docs, 'victim'))).toBe(false);
  });

  it('readGitBlob:仓库在受保护根内,或仓库的 gitdir 指向受保护根内 → 拒', async () => {
    const git = (cwd: string, args: string[]): string =>
      execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const inner = join(pluginsDir, 'victim');
    git(inner, ['init', '-q']);
    const sha = git(inner, ['hash-object', '-w', 'data.json']).trim();
    await expectDenied(call(C.READ_GIT_BLOB, inner, sha));
    const outer = join(home, 'repo');
    await mkdir(outer);
    await writeFile(join(outer, '.git'), `gitdir: ${join(inner, '.git')}\n`);
    const o = await outcome(call(C.READ_GIT_BLOB, outer, sha));
    expect(o).toContain('git repository not found within granted scope');
  });

  it('另一发行形态的 userData 同样受保护', async () => {
    const other = join(otherUserData, 'plugins', '_permissions.json');
    await expectDenied(call(C.READ_FILE, other));
    await expectDenied(call(C.WRITE_FILE, other, '{"evil":true}'));
    await expectDenied(call(C.RM, otherUserData, { recursive: true, force: true }));
    expect(await readFile(other, 'utf-8')).toBe('{}');
  });

  it('尚不存在的受保护根:不能被抢先创建(mkdir / writeFile / rename / cp / atomicReplace 的目标)', async () => {
    await expectDenied(call(C.MKDIR, notYet, { recursive: true }));
    await expectDenied(call(C.WRITE_FILE, notYet, 'x'));
    await expectDenied(call(C.RENAME, docs, notYet));
    await expectDenied(call(C.CP, docs, notYet, { recursive: true }));
    await expectDenied(call(C.ATOMIC_REPLACE, docs, notYet));
    await expectDenied(call(C.MKDIR, join(notYet, 'plugins'), { recursive: true }));
    expect(existsSync(notYet)).toBe(false);
    expect(existsSync(docs)).toBe(true);
  });

  it('不是存在性探测器:受保护根内存在 / 不存在的路径得到同一条拒绝(词法预判,不碰文件系统)', async () => {
    const existing = await outcome(call(C.STAT, join(pluginsDir, 'victim')));
    const missing = await outcome(call(C.STAT, join(pluginsDir, 'nope')));
    expect(existing).toContain(DENIED);
    expect(missing).toBe(existing);
    const wExisting = await outcome(call(C.WRITE_FILE, join(pluginsDir, 'victim', 'x'), ''));
    const wMissing = await outcome(call(C.WRITE_FILE, join(pluginsDir, 'nope', 'x'), ''));
    expect(wExisting).toContain(DENIED);
    expect(wMissing).toBe(wExisting);
  });

  it.skipIf(process.platform === 'linux')(
    '大小写不敏感文件系统:换大小写的写法同样被拒(rm -r `continuo dev`)',
    async () => {
      await expectDenied(call(C.RM, join(appData, 'continuo dev'), { recursive: true, force: true }));
      await expectDenied(call(C.READ_FILE, join(appData, 'CONTINUO DEV', 'plugins', '_permissions.json')));
      await expectDenied(call(C.RM, join(home, 'library'), { recursive: true, force: true }));
      expect(await readFile(permFile, 'utf-8')).toBe(permBefore);
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'macOS 数据卷别名(/System/Volumes/Data/…,realpath 不归一)同样被拒',
    async () => {
      const alias = (p: string): string => `/System/Volumes/Data${p}`;
      scopes.grant(PLUGIN, [{ path: alias(home), mode: 'rw' }]);
      expect(await call(C.READ_FILE, alias(join(docs, 'a.txt')))).toBe('hello'); // 别名写法本身可用
      await expectDenied(call(C.READ_FILE, alias(permFile)));
      await expectDenied(call(C.WRITE_FILE, alias(permFile), '{}'));
      await expectDenied(call(C.RM, alias(userData), { recursive: true, force: true }));
      await expectDenied(call(C.RM, alias(join(home, 'Library')), { recursive: true, force: true }));
      await expectDenied(call(C.RENAME, alias(appData), alias(join(home, 'Library', 'Moved'))));
      expect(await readFile(permFile, 'utf-8')).toBe(permBefore);
    },
  );
});

describe('经符号链接', () => {
  it('scope 内指向受保护根内的目录链接 / 文件链接:读、列、写都被拒', async () => {
    await symlink(pluginsDir, join(home, 'dlink'));
    await symlink(permFile, join(home, 'flink'));
    await expectDenied(call(C.READ_FILE, join(home, 'dlink', '_permissions.json')));
    await expectDenied(call(C.LIST_DIR, join(home, 'dlink')));
    await expectDenied(call(C.STAT, join(home, 'dlink', 'victim')));
    await expectDenied(call(C.LSTAT, join(home, 'dlink', '_permissions.json')));
    await expectDenied(call(C.WRITE_FILE, join(home, 'dlink', '_permissions.json'), '{}'));
    await expectDenied(call(C.RM, join(home, 'dlink', '_permissions.json')));
    await expectDenied(call(C.MKDIR, join(home, 'dlink', 'evil')));
    await expectDenied(call(C.CP, join(home, 'dlink'), join(docs, 'copy'), { recursive: true }));
    await expectDenied(call(C.READ_FILE, join(home, 'flink')));
    expect(await call(C.CHECK_PATH, join(home, 'flink'))).toBe(false);
    expect(await readFile(permFile, 'utf-8')).toBe(permBefore);
    // 作用在链接本身的操作不受影响:删掉的是链接,不是目标。
    expect(await outcome(call(C.RM, join(home, 'flink')))).toBe('ok');
    expect(await readFile(permFile, 'utf-8')).toBe(permBefore);
  });
});

describe('不是存在性探测器:词法预判认不出的写法(解析后才落进受保护根)', () => {
  async function expectSameDenial(existing: Promise<unknown>, missing: Promise<unknown>): Promise<void> {
    const [a, b] = await Promise.all([outcome(existing), outcome(missing)]);
    expect(a).toContain(DENIED);
    expect(b).toBe(a);
  }

  it('经 scope 内指向受保护根的目录链接:其下存在 / 不存在的路径得到同一条拒绝', async () => {
    await symlink(pluginsDir, join(home, 'dlink'));
    const [hit, miss] = [join(home, 'dlink', 'victim'), join(home, 'dlink', 'nope')];
    await expectSameDenial(call(C.STAT, hit), call(C.STAT, miss));
    await expectSameDenial(call(C.READ_FILE, join(hit, 'data.json')), call(C.READ_FILE, join(miss, 'data.json')));
    await expectSameDenial(call(C.LSTAT, hit), call(C.LSTAT, join(miss, 'x')));
    await expectSameDenial(call(C.WRITE_FILE, join(hit, 'x'), ''), call(C.WRITE_FILE, join(miss, 'x'), ''));
    expect(await call(C.CHECK_PATH, miss)).toBe(false);
  });

  it.skipIf(!volumeFoldsLongS)('经长 s 写法的祖先段:同样不可区分', async () => {
    const via = longS(pluginsDir, 'Application Support', 'Application ſupport');
    await expectSameDenial(call(C.STAT, join(via, 'victim')), call(C.STAT, join(via, 'nope')));
    await expectSameDenial(call(C.WRITE_FILE, join(via, 'victim', 'x'), ''), call(C.WRITE_FILE, join(via, 'nope', 'x'), ''));
  });

  it('受保护根之外:不存在的目标仍报「不存在」(已授权范围内的细节不变)', async () => {
    expect(await outcome(call(C.STAT, join(docs, 'nope')))).toContain('target does not exist');
    expect(await outcome(call(C.WRITE_FILE, join(docs, 'nope', 'x'), ''))).toContain('parent missing');
  });
});

describe('受保护根的祖先:会连带移动 / 删除 / 复制受保护子树的操作被拒', () => {
  it('rm -r / rename / cp -r / atomicReplace', async () => {
    const library = join(home, 'Library');
    await expectDenied(call(C.RM, appData, { recursive: true, force: true }));
    await expectDenied(call(C.RM, library, { recursive: true, force: true }));
    await expectDenied(call(C.RENAME, appData, join(library, 'Moved')));
    await expectDenied(call(C.RENAME, library, join(home, 'Lib2')));
    await expectDenied(call(C.CP, appData, join(docs, 'copy'), { recursive: true }));
    await expectDenied(call(C.CP, library, join(home, 'LibCopy'), { recursive: true }));
    await expectDenied(call(C.ATOMIC_REPLACE, library, join(home, 'Lib3')));
    await mkdir(join(home, 'staging'));
    await expectDenied(call(C.ATOMIC_REPLACE, join(home, 'staging'), library, { overwrite: true }));
    expect(await readFile(permFile, 'utf-8')).toBe(permBefore);
    expect(existsSync(join(docs, 'copy'))).toBe(false);
    expect(existsSync(join(home, 'LibCopy'))).toBe(false);
    expect(existsSync(join(home, 'Lib2'))).toBe(false);
    expect(existsSync(join(home, 'Lib3'))).toBe(false);
  });

  it('只读地看祖先不受影响:listDir 能看到 `Continuo Dev` 条目名,stat / lstat / mkdir -p 照常', async () => {
    const names = ((await call(C.LIST_DIR, appData)) as { name: string }[]).map((e) => e.name).sort();
    expect(names).toEqual(['Continuo', 'Continuo Dev']);
    expect(await outcome(call(C.STAT, join(home, 'Library')))).toBe('ok');
    expect(await outcome(call(C.LSTAT, appData))).toBe('ok');
    expect(await outcome(call(C.MKDIR, appData, { recursive: true }))).toBe('ok');
    expect(await call(C.CHECK_PATH, appData)).toBe(true);
  });
});

describe('受保护根之外(同一 scope 内)照常可用', () => {
  it('读 / 写 / mkdir / rename / cp / rm / atomicReplace', async () => {
    expect(await call(C.READ_FILE, join(docs, 'a.txt'))).toBe('hello');
    expect(await outcome(call(C.WRITE_FILE, join(docs, 'b.txt'), 'b'))).toBe('ok');
    expect(await outcome(call(C.MKDIR, join(docs, 'sub')))).toBe('ok');
    expect(await outcome(call(C.RENAME, join(docs, 'b.txt'), join(docs, 'c.txt')))).toBe('ok');
    expect(await outcome(call(C.CP, docs, join(home, 'docs2'), { recursive: true }))).toBe('ok');
    expect(await outcome(call(C.ATOMIC_REPLACE, join(home, 'docs2'), join(home, 'docs3')))).toBe('ok');
    expect(await outcome(call(C.RM, join(home, 'docs3'), { recursive: true }))).toBe('ok');
    expect(await readFile(join(docs, 'c.txt'), 'utf-8')).toBe('b');
  });

  it('名字只是以受保护根为前缀的兄弟目录不受影响', async () => {
    const sibling = join(appData, 'Continuo Devtools');
    expect(await outcome(call(C.MKDIR, sibling))).toBe('ok');
    expect(await outcome(call(C.WRITE_FILE, join(sibling, 'f.txt'), 'x'))).toBe('ok');
    expect(await call(C.READ_FILE, join(sibling, 'f.txt'))).toBe('x');
    expect(await outcome(call(C.RM, sibling, { recursive: true }))).toBe('ok');
  });
});

describe('requestScope', () => {
  it('请求的 scope 根位于受保护根之内(或就是受保护根)→ 直接 deny,不弹窗,不授予', async () => {
    scopes.revokeAll(PLUGIN);
    for (const p of [pluginsDir, join(pluginsDir, 'victim'), userData, otherUserData, join(notYet, 'x')]) {
      expect(await call(C.REQUEST_SCOPE, [{ path: p, mode: 'r' }])).toBe('deny');
    }
    // 与合法路径混在同一请求里也整体拒绝
    expect(
      await call(C.REQUEST_SCOPE, [
        { path: docs, mode: 'r' },
        { path: pluginsDir, mode: 'rw' },
      ]),
    ).toBe('deny');
    expect(event.sender.send).not.toHaveBeenCalled();
    expect(scopes.getScopes(PLUGIN)).toEqual([]);
  });

  it('已持有包含它的 `~` 授权时也不被静默覆盖成 grant', async () => {
    expect(await call(C.REQUEST_SCOPE, [{ path: pluginsDir, mode: 'rw' }])).toBe('deny');
    expect(event.sender.send).not.toHaveBeenCalled();
  });

  it('请求包含受保护根的目录(`~`)→ 照常弹窗;授予后受保护子树仍不可达', async () => {
    scopes.revokeAll(PLUGIN);
    const pending = call(C.REQUEST_SCOPE, [{ path: home, mode: 'rw' }]);
    await vi.waitFor(() => expect(event.sender.send).toHaveBeenCalled());
    const [channel, payload] = event.sender.send.mock.calls[0]! as [string, { requestId: string }];
    expect(channel).toBe(C.SCOPE_REQUEST);
    await ipc.invokeWithEvent(event, C.SCOPE_DECISION, payload.requestId, 'grant');
    expect(await pending).toBe('grant');
    expect(await call(C.READ_FILE, join(docs, 'a.txt'))).toBe('hello');
    await expectDenied(call(C.READ_FILE, permFile));
  });

  it('旧会话已持久化 / 已授予的受保护根内 scope 不生效', async () => {
    scopes.grant(PLUGIN, [{ path: pluginsDir, mode: 'rw' }]);
    await expectDenied(call(C.READ_FILE, permFile));
    await expectDenied(call(C.WRITE_FILE, permFile, '{}'));
  });
});

describe('受保护根的注入', () => {
  it('空 / 相对路径的根被忽略,不会把 cwd 之类当成受保护根', () => {
    const plain = new PathScopeRegistry(new IdentityRegistry(), { protectedRoots: ['', 'Continuo'] });
    expect(plain.isProtectedPath(process.cwd())).toBe(false);
    expect(plain.isProtectedPath(join(process.cwd(), 'Continuo', 'x'))).toBe(false);
  });

  it('根经符号链接给出时,其真实位置同样受保护', async () => {
    await symlink(userData, join(root, 'ud-link'));
    const viaLink = new PathScopeRegistry(new IdentityRegistry(), { protectedRoots: [join(root, 'ud-link')] });
    expect(viaLink.isProtectedPath(permFile)).toBe(true);
    expect(viaLink.isProtectedPath(join(root, 'ud-link', 'plugins'))).toBe(true);
    expect(viaLink.isProtectedPath(docs)).toBe(false);
  });
});

describe.skipIf(!volumeFoldsLongS)(
  '文件系统折叠 ≠ JS toLowerCase(长 s `ſ` ≡ `s`):叶子按磁盘上的真实名字判定',
  () => {
    let library: string;
    let appDataAlias: string; // `…/Library/Application ſupport`
    beforeEach(() => {
      library = join(home, 'Library');
      appDataAlias = longS(appData, 'Application Support', 'Application ſupport');
      expect(existsSync(appDataAlias)).toBe(true); // 前提:这个写法确实命中同一个目录
    });

    it('审计复现的五步链:移走祖先 → 偷读 → 改权限文件 → 移回 / 删光,每一步都被拒,磁盘不变', async () => {
      const stash = join(library, 'Stash');
      await expectDenied(call(C.RENAME, appDataAlias, stash));
      expect(readdirSync(library)).toEqual(['Application Support']);
      // 没被移走,后续两步自然落空(路径不存在)
      const moved = join(stash, 'Continuo Dev', 'plugins');
      expect(await outcome(call(C.READ_FILE, join(moved, 'victim', 'data.json')))).toContain('ScopeError');
      expect(await outcome(call(C.WRITE_FILE, join(moved, '_permissions.json'), '{}'))).toContain('ScopeError');
      await mkdir(stash); // 假设已被移走:移回(目标用长 s 写法)同样被拒
      await expectDenied(call(C.RENAME, stash, appDataAlias));
      await expectDenied(call(C.RM, appDataAlias, { recursive: true, force: true }));
      expect(readdirSync(library).sort()).toEqual(['Application Support', 'Stash']);
      expect(await readFile(permFile, 'utf-8')).toBe(permBefore);
      expect(await readFile(join(pluginsDir, 'victim', 'data.json'), 'utf-8')).toBe('{"token":"gho_secret"}');
    });

    it('祖先的长 s 写法:rename 源 / 目标、rm、cp 源 / 目标、atomicReplace、writeFile 全拒', async () => {
      await mkdir(join(library, 'Other'));
      await expectDenied(call(C.RENAME, appDataAlias, join(library, 'Moved')));
      await expectDenied(call(C.RENAME, join(library, 'Other'), appDataAlias));
      await expectDenied(call(C.RM, appDataAlias, { recursive: true }));
      await expectDenied(call(C.CP, appDataAlias, join(docs, 'copy'), { recursive: true }));
      await expectDenied(call(C.CP, docs, appDataAlias, { recursive: true }));
      await expectDenied(call(C.ATOMIC_REPLACE, appDataAlias, join(library, 'Final')));
      await expectDenied(call(C.ATOMIC_REPLACE, join(library, 'Other'), appDataAlias, { overwrite: true }));
      await expectDenied(call(C.WRITE_FILE, appDataAlias, 'x'));
      expect(readdirSync(library).sort()).toEqual(['Application Support', 'Other']);
      expect(existsSync(join(docs, 'copy'))).toBe(false);
      expect(await readFile(permFile, 'utf-8')).toBe(permBefore);
      // 只读地看祖先 / mkdir -p 仍照常(与标准写法一致)
      expect(await outcome(call(C.LSTAT, appDataAlias))).toBe('ok');
      expect(await outcome(call(C.MKDIR, appDataAlias, { recursive: true }))).toBe('ok');
    });

    it('受保护根本身的长 s 写法(`ſecrets`):lstat / rm / rename / writeFile / mkdir / cp / atomicReplace 全拒', async () => {
      const alias = join(cfg, 'ſecrets');
      expect(existsSync(alias)).toBe(true);
      await mkdir(join(cfg, 'staging'));
      await expectDenied(call(C.LSTAT, alias));
      await expectDenied(call(C.RM, alias, { recursive: true, force: true }));
      await expectDenied(call(C.RENAME, alias, join(cfg, 'moved')));
      await expectDenied(call(C.RENAME, join(cfg, 'staging'), alias));
      await expectDenied(call(C.WRITE_FILE, alias, 'x'));
      await expectDenied(call(C.MKDIR, alias, { recursive: true }));
      await expectDenied(call(C.CP, alias, join(docs, 'copy'), { recursive: true }));
      await expectDenied(call(C.CP, docs, alias, { recursive: true }));
      await expectDenied(call(C.ATOMIC_REPLACE, alias, join(cfg, 'final')));
      await expectDenied(call(C.ATOMIC_REPLACE, join(cfg, 'staging'), alias, { overwrite: true }));
      expect(readdirSync(cfg).sort()).toEqual(['Secrets', 'staging']);
      expect(await readFile(join(secrets, 'key'), 'utf-8')).toBe('k');
    });

    it('符号链接叶子:磁盘条目名是受保护根(词法形)祖先的链接,用长 s 写法移动 / 删除它 → 拒', async () => {
      const alias = join(home, 'ſLib');
      expect((await fsp.lstat(alias)).isSymbolicLink()).toBe(true);
      await expectDenied(call(C.RENAME, alias, join(home, 'MovedLib')));
      await expectDenied(call(C.RM, alias));
      expect(await readlink(join(home, 'SLib'))).toBe(join(home, 'reallib'));
      expect(existsSync(join(home, 'MovedLib'))).toBe(false);
    });

    it('符号链接叶子:普通链接用折叠变体名引用,操作作用在正确条目上且不被误拒', async () => {
      await symlink(docs, join(home, 'Shortcut'));
      const alias = join(home, 'ſhortcut');
      expect(await outcome(call(C.LSTAT, alias))).toBe('ok');
      expect(await outcome(call(C.RENAME, alias, join(home, 'Renamed')))).toBe('ok');
      expect(await readlink(join(home, 'Renamed'))).toBe(docs);
      expect(await outcome(call(C.RM, join(home, 'Renamed')))).toBe('ok');
      expect(existsSync(join(home, 'Renamed'))).toBe(false);
      expect(await readFile(join(docs, 'a.txt'), 'utf-8')).toBe('hello'); // 删的是链接,不是目标
    });

    it('找不出链接叶子的磁盘条目名(扫描超限)时:祖先链上的目录 fail-closed 拒绝;其它目录不受影响', async () => {
      const limited = await extraStack({ onDiskNameScanLimit: 1 });
      await symlink(docs, join(home, 'Shortcut')); // `home` 是受保护根的祖先,条目数 > 1
      await expectDenied(limited(C.RM, join(home, 'ſhortcut')));
      expect(await readlink(join(home, 'Shortcut'))).toBe(docs);
      // 不在任何受保护根祖先链上的目录:不解析磁盘条目名,照常
      await writeFile(join(docs, 'b.txt'), '');
      await symlink(join(docs, 'a.txt'), join(docs, 'Slink'));
      expect(await outcome(limited(C.RM, join(docs, 'ſlink')))).toBe('ok');
      expect(existsSync(join(docs, 'Slink'))).toBe(false);
    });

    it('尚不存在的受保护根:不能用折叠等价的变体名抢先创建;同目录里其它新名字照常', async () => {
      const alias = join(cfg, 'Nextſecrets');
      await mkdir(join(cfg, 'staging'));
      await expectDenied(call(C.MKDIR, alias));
      await expectDenied(call(C.WRITE_FILE, alias, 'x'));
      await expectDenied(call(C.RENAME, join(cfg, 'staging'), alias));
      await expectDenied(call(C.CP, docs, alias, { recursive: true }));
      await expectDenied(call(C.ATOMIC_REPLACE, join(cfg, 'staging'), alias));
      expect(readdirSync(cfg).sort()).toEqual(['Secrets', 'staging']);
      expect(await outcome(call(C.MKDIR, join(cfg, 'NextStuff')))).toBe('ok');
      expect(await outcome(call(C.WRITE_FILE, join(cfg, 'notes.txt'), 'x'))).toBe('ok');
    });
  },
);

describe('磁盘条目名解析的范围与开销', () => {
  it('祖先链上的目录里:标准写法的普通读写 / 改名 / 删除不被误拒', async () => {
    expect(await outcome(call(C.WRITE_FILE, join(home, 'new.txt'), 'x'))).toBe('ok');
    expect(await outcome(call(C.WRITE_FILE, join(home, 'new.txt'), 'y'))).toBe('ok');
    expect(await outcome(call(C.RENAME, join(home, 'new.txt'), join(home, 'new2.txt')))).toBe('ok');
    expect(await outcome(call(C.RM, join(home, 'new2.txt')))).toBe('ok');
    expect(await outcome(call(C.MKDIR, join(home, 'Library', 'Caches')))).toBe('ok');
    await symlink(docs, join(home, 'Shortcut'));
    expect(await outcome(call(C.RM, join(home, 'Shortcut')))).toBe('ok');
    expect(existsSync(docs)).toBe(true);
  });

  it('不在祖先链上的目录:写类校验不新增 realpath / readdir(只有父目录那一次 realpath)', async () => {
    const realpathSpy = vi.spyOn(fsp, 'realpath');
    const opendirSpy = vi.spyOn(fsp, 'opendir');
    await call(C.LSTAT, join(docs, 'a.txt'));
    expect(realpathSpy).toHaveBeenCalledTimes(1);
    expect(opendirSpy).not.toHaveBeenCalled();
    // 对照:祖先链上的目录多一次 realpath(叶子的真实名字),普通条目仍不 readdir
    realpathSpy.mockClear();
    await call(C.LSTAT, docs);
    if (process.platform !== 'linux') expect(realpathSpy).toHaveBeenCalledTimes(2);
    expect(opendirSpy).not.toHaveBeenCalled();
  });

  it('Linux(大小写敏感,不折叠)分支不变:不解析磁盘条目名,名字只差一个 `ſ` 的新目录可创建', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    try {
      const linux = await extraStack();
      const realpathSpy = vi.spyOn(fsp, 'realpath');
      await linux(C.LSTAT, docs);
      expect(realpathSpy).toHaveBeenCalledTimes(1);
      expect(await outcome(linux(C.MKDIR, join(cfg, 'Nextſecrets')))).toBe('ok');
      await expectDenied(linux(C.MKDIR, nextSecrets));
      await expectDenied(linux(C.RM, appData, { recursive: true }));
      // `/.nofollow` 等只在 macOS 是合成前缀;Linux 上是普通名字,不特殊对待
      const plain = new PathScopeRegistry(new IdentityRegistry(), { protectedRoots: allRoots });
      expect(plain.isProtectedPath('/.nofollow/home/x')).toBe(false);
      expect(plain.isProtectedPath('/.vol/1/2')).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

// ───────────────────────── 文件系统别名:同一个目录的另一种路径(realpath 不归一) ─────────────────────────

// macOS 根目录下内核合成的 `/.nofollow`:`/.nofollow/<绝对路径>` 与 `<绝对路径>` 是同一个文件。其它平台 / 不提供它的
// 系统上跳过(Linux CI)。
const hasNoFollow = process.platform === 'darwin' && existsSync(`/.nofollow${realpathSync(tmpdir())}`);
const nf = (p: string): string => `/.nofollow${p}`;

describe.skipIf(!hasNoFollow)('macOS `/.nofollow/<绝对路径>`(同一 inode,realpath 不归一);scope 授到 `/`', () => {
  beforeEach(() => {
    scopes.grant(PLUGIN, [{ path: '/', mode: 'rw' }]);
  });

  it('前提:`/.nofollow` 写法确实到达同一个文件,realpath 保留该前缀', async () => {
    expect(await readFile(nf(permFile), 'utf-8')).toBe(permBefore);
    expect(await realpath(nf(permFile))).toBe(nf(permFile));
    expect(statSync(nf(userData)).ino).toBe(statSync(userData).ino);
  });

  it('审计复现的六个操作:读 / 改权限文件、列插件目录、checkPath、rm -r userData、rename userData → 全拒,磁盘不变', async () => {
    await expectDenied(call(C.READ_FILE, nf(permFile)));
    await expectDenied(call(C.WRITE_FILE, nf(permFile), `{"${PLUGIN}":{"decisions":[{"permission":"shell","granted":true,"decidedAt":2}]}}`));
    await expectDenied(call(C.LIST_DIR, nf(pluginsDir)));
    expect(await call(C.CHECK_PATH, nf(permFile))).toBe(false);
    await expectDenied(call(C.RM, nf(userData), { recursive: true, force: true }));
    await expectDenied(call(C.RENAME, nf(userData), nf(join(appData, 'Continuo Dev Pwned'))));
    expect(await readFile(permFile, 'utf-8')).toBe(permBefore);
    expect(readdirSync(appData).sort()).toEqual(['Continuo', 'Continuo Dev']);
    expect(existsSync(join(pluginsDir, 'victim', 'data.json'))).toBe(true);
  });

  it('其余入口:stat / lstat / realpath / mkdir / cp(源与目标)/ atomicReplace / 另一发行形态 / 经链接给出的根', async () => {
    await expectDenied(call(C.STAT, nf(permFile)));
    await expectDenied(call(C.LSTAT, nf(userData)));
    await expectDenied(call(C.REALPATH, nf(permFile)));
    await expectDenied(call(C.MKDIR, nf(join(pluginsDir, 'evil')), { recursive: true }));
    await expectDenied(call(C.CP, nf(permFile), join(docs, 'stolen.json')));
    await expectDenied(call(C.CP, nf(join(pluginsDir, 'victim')), join(docs, 'victim'), { recursive: true }));
    await expectDenied(call(C.CP, join(docs, 'a.txt'), nf(join(pluginsDir, 'victim', 'evil.js'))));
    await writeFile(join(docs, 'staging.json'), '{}');
    await expectDenied(call(C.ATOMIC_REPLACE, nf(join(docs, 'staging.json')), nf(permFile), { overwrite: true }));
    await expectDenied(call(C.READ_FILE, nf(join(otherUserData, 'plugins', '_permissions.json'))));
    await expectDenied(call(C.WRITE_FILE, nf(join(secrets, 'key')), 'evil'));
    await expectDenied(call(C.LIST_DIR, nf(join(home, 'reallib', 'App'))));
    expect(await readFile(permFile, 'utf-8')).toBe(permBefore);
    expect(await readFile(join(secrets, 'key'), 'utf-8')).toBe('k');
    expect(existsSync(join(pluginsDir, 'evil'))).toBe(false);
    expect(existsSync(join(docs, 'stolen.json'))).toBe(false);
    expect(existsSync(join(docs, 'victim'))).toBe(false);
  });

  it('受保护根的祖先:rm -r / rename(源与目标)/ cp -r(源与目标)/ atomicReplace / writeFile → 拒', async () => {
    const library = join(home, 'Library');
    await mkdir(join(home, 'staging'));
    await expectDenied(call(C.RM, nf(appData), { recursive: true, force: true }));
    await expectDenied(call(C.RM, nf(library), { recursive: true, force: true }));
    await expectDenied(call(C.RENAME, nf(appData), nf(join(library, 'Moved'))));
    await expectDenied(call(C.RENAME, join(home, 'staging'), nf(library)));
    await expectDenied(call(C.CP, nf(library), join(home, 'LibCopy'), { recursive: true }));
    await expectDenied(call(C.CP, join(home, 'staging'), nf(appData), { recursive: true }));
    await expectDenied(call(C.ATOMIC_REPLACE, nf(library), nf(join(home, 'Lib3'))));
    await expectDenied(call(C.ATOMIC_REPLACE, join(home, 'staging'), nf(library), { overwrite: true }));
    await expectDenied(call(C.WRITE_FILE, nf(appData), 'x'));
    expect(await readFile(permFile, 'utf-8')).toBe(permBefore);
    expect(existsSync(join(home, 'LibCopy'))).toBe(false);
    expect(existsSync(join(home, 'Lib3'))).toBe(false);
    expect(existsSync(join(library, 'Moved'))).toBe(false);
  });

  it('尚不存在的受保护根:不能经别名抢先创建(mkdir / writeFile / rename / cp / atomicReplace 的目标,及其下的路径)', async () => {
    await expectDenied(call(C.MKDIR, nf(notYet), { recursive: true }));
    await expectDenied(call(C.WRITE_FILE, nf(notYet), 'x'));
    await expectDenied(call(C.RENAME, docs, nf(notYet)));
    await expectDenied(call(C.CP, docs, nf(notYet), { recursive: true }));
    await expectDenied(call(C.ATOMIC_REPLACE, docs, nf(notYet)));
    await expectDenied(call(C.MKDIR, nf(join(notYet, 'plugins')), { recursive: true }));
    await expectDenied(call(C.MKDIR, nf(nextSecrets)));
    expect(existsSync(notYet)).toBe(false);
    expect(existsSync(nextSecrets)).toBe(false);
    expect(existsSync(docs)).toBe(true);
  });

  it('不是存在性探测器:别名下受保护根内存在 / 不存在的路径得到同一条拒绝', async () => {
    const existing = await outcome(call(C.STAT, nf(join(pluginsDir, 'victim'))));
    const missing = await outcome(call(C.STAT, nf(join(pluginsDir, 'nope'))));
    expect(existing).toContain(DENIED);
    expect(missing.replace('nope', 'victim')).toBe(existing);
    const wMissing = await outcome(call(C.WRITE_FILE, nf(join(pluginsDir, 'nope', 'x')), ''));
    expect(wMissing).toContain(DENIED);
  });

  it('第二层:`/.nofollow`、`/.resolve/<n>`、`/.vol/<dev>/<ino>` 下的任何路径都不认(与受保护根无关),requestScope 直接 deny', async () => {
    const file = join(docs, 'a.txt');
    const st = statSync(docs, { bigint: true });
    expect(await call(C.READ_FILE, file)).toBe('hello'); // 标准写法照常
    for (const alias of [nf(file), `/.NOFOLLOW${file}`, `/.resolve/1${file}`, `/.vol/${st.dev}/${st.ino}/a.txt`]) {
      await expectDenied(call(C.READ_FILE, alias));
      await expectDenied(call(C.WRITE_FILE, alias, 'changed'));
      await expectDenied(call(C.LSTAT, alias));
      expect(await call(C.CHECK_PATH, alias)).toBe(false);
    }
    await expectDenied(call(C.LIST_DIR, '/.nofollow'));
    // scope 内指向合成前缀的链接:realpath 报出 `/.nofollow/…`,同样不认
    await symlink(nf(docs), join(home, 'magic'));
    await expectDenied(call(C.READ_FILE, join(home, 'magic', 'a.txt')));
    expect(await readFile(file, 'utf-8')).toBe('hello');

    scopes.revokeAll(PLUGIN);
    for (const p of [nf(docs), nf(home), '/.nofollow', `/.resolve/1${docs}`, `/.vol/${st.dev}/${st.ino}`, '/.vol']) {
      expect(await call(C.REQUEST_SCOPE, [{ path: p, mode: 'r' }])).toBe('deny');
    }
    expect(event.sender.send).not.toHaveBeenCalled();
    expect(scopes.getScopes(PLUGIN)).toEqual([]);
  });

  it('合法回归(scope `/`):home 下普通读写、Application Support 下的兄弟目录、名字含 Continuo 的工作区、只读地看祖先', async () => {
    expect(await call(C.READ_FILE, join(docs, 'a.txt'))).toBe('hello');
    expect(await outcome(call(C.WRITE_FILE, join(docs, 'b.txt'), 'b'))).toBe('ok');
    expect(await outcome(call(C.MKDIR, join(appData, 'Other App'), { recursive: true }))).toBe('ok');
    expect(await outcome(call(C.WRITE_FILE, join(appData, 'Other App', 'conf.json'), '{}'))).toBe('ok');
    expect(await outcome(call(C.RENAME, join(appData, 'Other App'), join(appData, 'Continuo Devtools')))).toBe('ok');
    expect(await outcome(call(C.RM, join(appData, 'Continuo Devtools'), { recursive: true }))).toBe('ok');
    const ws = join(home, 'code', 'Continuo');
    await mkdir(ws, { recursive: true });
    expect(await outcome(call(C.MKDIR, join(ws, 'src')))).toBe('ok');
    expect(await outcome(call(C.WRITE_FILE, join(ws, 'src', 'main.ts'), 'x'))).toBe('ok');
    expect(await outcome(call(C.CP, ws, join(home, 'code', 'Continuo Dev'), { recursive: true }))).toBe('ok');
    expect(await outcome(call(C.RM, ws, { recursive: true }))).toBe('ok');
    expect(await outcome(call(C.STAT, appData))).toBe('ok');
    expect(await outcome(call(C.LIST_DIR, join(home, 'Library')))).toBe('ok');
    expect(await outcome(call(C.STAT, '/'))).toBe('ok');
  });
});

describe('按 (dev, ino) 判定:路径字符串对不上、文件系统里却是同一个目录', () => {
  // 启动(构造 registry)时 `<home>/later` 还不存在;之后它成了指向别处的链接,受保护根 `<home>/later/App` 的真实
  // 位置是 `<home>/far/away/App` —— 构造时算出的比较键里没有这条路径,只有 inode 认得出。
  let realRoot: string;
  beforeEach(async () => {
    realRoot = join(home, 'far', 'away', 'App');
    await mkdir(realRoot, { recursive: true });
    await writeFile(join(realRoot, 'secret'), 's');
    await symlink(join(home, 'far', 'away'), join(home, 'later'));
  });

  it('之内(含根本身):读 / 写 / 列 / stat / mkdir / rm / rename / cp / atomicReplace / checkPath 全拒,存在与否不可区分', async () => {
    await expectDenied(call(C.READ_FILE, join(realRoot, 'secret')));
    await expectDenied(call(C.WRITE_FILE, join(realRoot, 'secret'), 'evil'));
    await expectDenied(call(C.WRITE_FILE, join(realRoot, 'new'), 'evil'));
    await expectDenied(call(C.LIST_DIR, realRoot));
    await expectDenied(call(C.STAT, realRoot));
    await expectDenied(call(C.LSTAT, join(realRoot, 'secret')));
    await expectDenied(call(C.MKDIR, join(realRoot, 'sub'), { recursive: true }));
    await expectDenied(call(C.RM, join(realRoot, 'secret')));
    await expectDenied(call(C.RM, realRoot, { recursive: true, force: true }));
    await expectDenied(call(C.RENAME, realRoot, join(home, 'far', 'away', 'Moved')));
    await expectDenied(call(C.CP, realRoot, join(docs, 'copy'), { recursive: true }));
    await expectDenied(call(C.CP, join(docs, 'a.txt'), join(realRoot, 'a.txt')));
    await expectDenied(call(C.ATOMIC_REPLACE, join(docs, 'a.txt'), join(realRoot, 'secret'), { overwrite: true }));
    expect(await call(C.CHECK_PATH, join(realRoot, 'secret'))).toBe(false);
    const existing = await outcome(call(C.STAT, join(realRoot, 'secret')));
    const missing = await outcome(call(C.STAT, join(realRoot, 'nope', 'deeper')));
    expect(missing.replace(join('nope', 'deeper'), 'secret')).toBe(existing);
    expect(await readFile(join(realRoot, 'secret'), 'utf-8')).toBe('s');
    expect(readdirSync(realRoot)).toEqual(['secret']);
    expect(existsSync(join(docs, 'copy'))).toBe(false);
    expect(await readFile(join(docs, 'a.txt'), 'utf-8')).toBe('hello');
  });

  it('是受保护根的上级:rm -r / rename(源与目标)/ cp -r / atomicReplace / writeFile 被拒;只读地看与同级目录照常', async () => {
    const away = join(home, 'far', 'away');
    await mkdir(join(home, 'staging'));
    await expectDenied(call(C.RM, away, { recursive: true, force: true }));
    await expectDenied(call(C.RENAME, away, join(home, 'far', 'gone')));
    await expectDenied(call(C.RENAME, join(home, 'staging'), away));
    await expectDenied(call(C.CP, away, join(docs, 'copy'), { recursive: true }));
    await expectDenied(call(C.ATOMIC_REPLACE, away, join(home, 'far', 'gone')));
    await expectDenied(call(C.ATOMIC_REPLACE, join(home, 'staging'), away, { overwrite: true }));
    await expectDenied(call(C.WRITE_FILE, away, 'x'));
    expect(await readFile(join(realRoot, 'secret'), 'utf-8')).toBe('s');
    expect(existsSync(join(home, 'far', 'gone'))).toBe(false);
    expect(existsSync(join(docs, 'copy'))).toBe(false);
    const names = ((await call(C.LIST_DIR, away)) as { name: string }[]).map((e) => e.name);
    expect(names).toEqual(['App']);
    expect(await outcome(call(C.STAT, away))).toBe('ok');
    expect(await outcome(call(C.WRITE_FILE, join(away, 'sibling.txt'), 'x'))).toBe('ok');
    expect(await outcome(call(C.RM, join(away, 'sibling.txt')))).toBe('ok');
  });

  it('通用:scope 内指向受保护根祖先的目录链接别名 —— 经它对祖先做 rm / rename / cp / atomicReplace / writeFile 被拒', async () => {
    const alias = join(docs, 'toLib'); // → <home>/Library
    await symlink(join(home, 'Library'), alias);
    const viaAlias = join(alias, 'Application Support');
    await mkdir(join(home, 'staging'));
    await expectDenied(call(C.RM, viaAlias, { recursive: true, force: true }));
    await expectDenied(call(C.RENAME, viaAlias, join(alias, 'Moved')));
    await expectDenied(call(C.RENAME, join(home, 'staging'), viaAlias));
    await expectDenied(call(C.CP, viaAlias, join(docs, 'copy'), { recursive: true }));
    await expectDenied(call(C.CP, alias, join(docs, 'copy'), { recursive: true })); // 源跟随链接 = 整个 Library
    await expectDenied(call(C.CP, join(home, 'staging'), viaAlias, { recursive: true }));
    await expectDenied(call(C.ATOMIC_REPLACE, viaAlias, join(alias, 'Moved')));
    await expectDenied(call(C.ATOMIC_REPLACE, join(home, 'staging'), viaAlias, { overwrite: true }));
    await expectDenied(call(C.WRITE_FILE, viaAlias, 'x'));
    await expectDenied(call(C.RM, join(viaAlias, 'Continuo Dev'), { recursive: true, force: true }));
    await expectDenied(call(C.READ_FILE, join(viaAlias, 'Continuo Dev', 'plugins', '_permissions.json')));
    expect(await readFile(permFile, 'utf-8')).toBe(permBefore);
    expect(existsSync(join(docs, 'copy'))).toBe(false);
    expect(existsSync(join(home, 'Library', 'Moved'))).toBe(false);
    // 链接本身可以删(作用在链接,不是目标)
    expect(await outcome(call(C.RM, alias))).toBe('ok');
    expect(existsSync(appData)).toBe(true);
  });

  it('开销(未命中身份缓存时):每次校验新增的 stat 有上限 —— 只看不动的操作 = 目标路径级数 + 受保护根写法数;会动整棵子树的操作再加根的各级上级;不新增 realpath / readdir', async () => {
    const levels = (p: string): string[] => {
      const out = [p];
      while (dirname(out[out.length - 1]!) !== out[out.length - 1]) out.push(dirname(out[out.length - 1]!));
      return out;
    };
    identityCacheOff = true; // 本用例量的是冷开销(命中缓存后的次数见 identity-cache.spec.ts)
    const target = join(docs, 'a.txt');
    const rootForms = [...allRoots, join(home, 'reallib', 'App')]; // 词法形 + 构造时经链接的那条根的 realpath 形
    const statSpy = vi.spyOn(fsp, 'stat');
    const lstatSpy = vi.spyOn(fsp, 'lstat');
    const realpathSpy = vi.spyOn(fsp, 'realpath');
    const opendirSpy = vi.spyOn(fsp, 'opendir');
    const stats = (): number => statSpy.mock.calls.length + lstatSpy.mock.calls.length;

    await scopes.check(token, event.sender.id, 'lstat', target, 'r');
    expect(stats()).toBe(levels(target).length + rootForms.length);
    expect(realpathSpy).toHaveBeenCalledTimes(1);

    statSpy.mockClear();
    lstatSpy.mockClear();
    await scopes.check(token, event.sender.id, 'read', target, 'r');
    expect(stats()).toBe(levels(target).length + rootForms.length);

    // 会连带整棵子树的操作(rm / rename / cp 源 / write):再加受保护根各写法的不同上级(途经的链接多一次)
    statSpy.mockClear();
    lstatSpy.mockClear();
    await scopes.check(token, event.sender.id, 'remove', target, 'rw');
    const protectedLevels = new Set(rootForms.flatMap(levels)).size;
    const links = 2; // SLib、later
    expect(stats()).toBe(levels(target).length + protectedLevels + links);
    expect(opendirSpy).not.toHaveBeenCalled();
  });

  it('没有受保护根的 registry:不做任何额外 stat', async () => {
    const identity = new IdentityRegistry();
    const plain = new PathScopeRegistry(identity, {});
    const { token: t } = identity.register(PLUGIN, 9);
    plain.grant(PLUGIN, [{ path: home, mode: 'rw' }]);
    const statSpy = vi.spyOn(fsp, 'stat');
    const lstatSpy = vi.spyOn(fsp, 'lstat');
    await plain.check(t, 9, 'read', join(docs, 'a.txt'), 'r');
    expect(statSpy).not.toHaveBeenCalled();
    expect(lstatSpy).not.toHaveBeenCalled();
  });
});
