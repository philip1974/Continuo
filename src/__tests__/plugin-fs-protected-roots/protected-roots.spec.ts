// 安全:应用自身的数据目录(userData,含另一发行形态的)与安装目录是「受保护根」—— 无论插件拿到多宽的
// path-scope(如 `~`),其下任何路径都不可读写。行为见同目录 README。
// 经真实 plugin-fs IPC handler + 真实 PathScopeRegistry + 真实临时目录验证。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { registerPluginFsHandlers } from '../../../electron/main/services/plugin-fs.service';
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
let pluginsDir: string;
let permFile: string;
let docs: string;
let ipc: StubIpcMain;
let scopes: PathScopeRegistry;
let correlator: ScopeRequestCorrelator;
let token: string;
let event: ReturnType<typeof makeFakeEvent>;
let permBefore: string;

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

  event = makeFakeEvent({ id: 1, isDestroyed: () => false });
  ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  scopes = new PathScopeRegistry(identity, { protectedRoots: [userData, otherUserData, notYet] });
  correlator = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
  registerPluginFsHandlers(ipc as never, {
    identityRegistry: identity,
    pathScopeRegistry: scopes,
    correlator,
    webContentsForSender: () => null,
  });
  token = ((await ipc.invokeWithEvent(event, C.REGISTER_PLUGIN, PLUGIN)) as { token: string }).token;
  scopes.grant(PLUGIN, [{ path: home, mode: 'rw' }]);
  event.sender.send.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  correlator.dispose();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

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
