// 安全:scope 外路径一律同一条拒绝,不因目标存在与否 / 类型而不同,且不碰文件系统。行为见同目录 README。
import { promises as fsp } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { registerPluginFsHandlers } from '../../../electron/main/services/plugin-fs.service';
import { ScopeError } from '../../plugins/types';
import { StubIpcMain, makeFakeEvent } from '../sdk-contract/integration/make-stub-ipc';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') } }));

const PLUGIN = 'plugin.probe';
const C = PLUGIN_FS_CHANNELS;

let root: string; // canonical
let outside: string;
let scope: string;
let ipc: StubIpcMain;
let scopes: PathScopeRegistry;
let correlator: ScopeRequestCorrelator;
let token: string;
const event = makeFakeEvent({ id: 1, isDestroyed: () => false });

function call(channel: string, ...args: unknown[]): Promise<unknown> {
  return ipc.invokeWithEvent(event, channel, token, ...args);
}

/** 调用结果的可观察形态:成功 → 'ok';失败 → 错误类名 + code + message + details。 */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    const e = err as Error & { code?: string; details?: { reason?: string } };
    return JSON.stringify([e.name, e.code, e.message, e.details?.reason]);
  }
}

/** 经真实 request-scope 流程授予(用户点「允许」)。 */
async function requestAndGrant(path: string, mode: 'r' | 'rw'): Promise<unknown> {
  const before = event.sender.send.mock.calls.length;
  const pending = call(C.REQUEST_SCOPE, [{ path, mode }]);
  await vi.waitFor(() => {
    if (event.sender.send.mock.calls.length === before) throw new Error('scope-request 未发出');
  });
  const [, payload] = event.sender.send.mock.calls[before]!;
  await ipc.invokeWithEvent(event, C.SCOPE_DECISION, (payload as { requestId: string }).requestId, 'grant');
  return pending;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'scope-oracle-')));
  outside = join(root, 'outside');
  scope = join(root, 'scope');
  await mkdir(join(outside, 'dir'), { recursive: true });
  await mkdir(scope);
  await writeFile(join(outside, 'file.txt'), 'secret');
  await writeFile(join(scope, 'in.txt'), 'in');
  await symlink(join(outside, 'file.txt'), join(outside, 'link'));
  ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  scopes = new PathScopeRegistry(identity);
  correlator = new ScopeRequestCorrelator({ ttlMs: 60_000 });
  registerPluginFsHandlers(ipc as never, {
    identityRegistry: identity,
    pathScopeRegistry: scopes,
    correlator,
  });
  token = ((await ipc.invokeWithEvent(event, C.REGISTER_PLUGIN, PLUGIN)) as { token: string }).token;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  correlator.dispose();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('scope 外路径:同一条错误,与存在性 / 类型无关', () => {
  /** scope 外的各种目标:存在的文件 / 目录 / 符号链接、不存在、上级不存在、上级是文件(ENOTDIR)。 */
  function probes(): string[] {
    return [
      join(outside, 'file.txt'),
      join(outside, 'dir'),
      join(outside, 'link'),
      join(outside, 'missing'),
      join(outside, 'missing-dir', 'x'),
      join(outside, 'file.txt', 'x'),
    ];
  }

  const ops: [string, (p: string) => Promise<unknown>][] = [
    ['stat', (p) => call(C.STAT, p)],
    ['lstat', (p) => call(C.LSTAT, p)],
    ['readFile', (p) => call(C.READ_FILE, p)],
    ['listDir', (p) => call(C.LIST_DIR, p)],
    ['realpath', (p) => call(C.REALPATH, p)],
    ['writeFile', (p) => call(C.WRITE_FILE, p, 'x')],
    ['mkdir', (p) => call(C.MKDIR, p)],
    ['rm', (p) => call(C.RM, p)],
    ['rename', (p) => call(C.RENAME, p, `${p}.new`)],
    ['cp(src)', (p) => call(C.CP, p, join(scope, 'copy'))],
    ['cp(dst)', (p) => call(C.CP, join(scope, 'in.txt'), p)],
  ];

  for (const withScope of [false, true]) {
    for (const [name, op] of ops) {
      it(`${name}(${withScope ? '已授其它 scope' : '未授任何 scope'}):各种目标的结果完全相同`, async () => {
        if (withScope) scopes.grant(PLUGIN, [{ path: scope, mode: 'rw' }]);
        const results = new Set<string>();
        for (const p of probes()) results.add(await outcome(op(p)));
        expect([...results]).toHaveLength(1);
        const [only] = [...results];
        expect(only).toContain('target not in any granted scope');
        expect(only).toContain('SCOPE_ERROR');
      });
    }
  }

  it('scope 外路径不触发 realpath / lstat', async () => {
    scopes.grant(PLUGIN, [{ path: scope, mode: 'rw' }]);
    const realpathSpy = vi.spyOn(fsp, 'realpath');
    const lstatSpy = vi.spyOn(fsp, 'lstat');
    await outcome(call(C.STAT, join(outside, 'file.txt')));
    await outcome(call(C.WRITE_FILE, join(outside, 'file.txt'), 'x'));
    await outcome(call(C.RM, join(outside, 'missing')));
    expect(realpathSpy).not.toHaveBeenCalled();
    expect(lstatSpy).not.toHaveBeenCalled();
  });

  it('只读 scope 内的写操作:同一条拒绝,不因目标 / 父目录存在与否而不同', async () => {
    scopes.grant(PLUGIN, [{ path: scope, mode: 'r' }]);
    const a = await outcome(call(C.WRITE_FILE, join(scope, 'in.txt'), 'x'));
    const b = await outcome(call(C.WRITE_FILE, join(scope, 'no-dir', 'x.txt'), 'x'));
    expect(a).toBe(b);
    expect(a).toContain('target not in any granted scope');
  });

  it('`..` 词法折叠后落在 scope 外 → 同一条拒绝', async () => {
    scopes.grant(PLUGIN, [{ path: scope, mode: 'r' }]);
    const a = await outcome(call(C.STAT, join(scope, '..', 'outside', 'file.txt')));
    const b = await outcome(call(C.STAT, `${scope}/../outside/missing`));
    expect(a).toBe(b);
    expect(a).toContain('target not in any granted scope');
  });

  it('被拒原因记入主进程日志', async () => {
    await outcome(call(C.STAT, join(outside, 'file.txt')));
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes(PLUGIN))).toBe(true);
  });
});

describe('scope 内:原有细节与功能不变', () => {
  beforeEach(() => {
    scopes.grant(PLUGIN, [{ path: scope, mode: 'rw' }]);
  });

  it('存在 → 成功;不存在 → target does not exist;写到不存在的父目录 → parent missing', async () => {
    expect(await call(C.READ_FILE, join(scope, 'in.txt'))).toBe('in');
    await expect(call(C.STAT, join(scope, 'missing'))).rejects.toThrow(/target does not exist/);
    await expect(call(C.WRITE_FILE, join(scope, 'no-dir', 'x'), 'x')).rejects.toThrow(/parent missing/);
  });

  it('scope 内符号链接指向 scope 外 → 照旧拒绝', async () => {
    await symlink(join(outside, 'file.txt'), join(scope, 'escape'));
    const err = await call(C.READ_FILE, join(scope, 'escape')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeError);
    expect((err as Error).message).toBe('target not in any granted scope');
    // 错误不带解析结果(不泄露链接指向哪里)。
    expect(JSON.stringify((err as ScopeError).details)).not.toContain('outside');
  });

  it.skipIf(process.platform === 'linux')('大小写不敏感的平台:路径大小写不同仍可访问', async () => {
    const upper = join(root, 'SCOPE', 'in.txt');
    // 仅当文件系统确实大小写不敏感时才有意义。
    const insensitive = await realpath(upper).then(
      () => true,
      () => false,
    );
    if (insensitive) expect(await call(C.READ_FILE, upper)).toBe('in');
  });

  it.skipIf(process.platform === 'linux')('Unicode 规范化形式不同(NFD 写法访问 NFC 的 scope)仍可访问', async () => {
    const nfcScope = join(root, 'caf\u00e9');
    await mkdir(nfcScope);
    await writeFile(join(nfcScope, 'in.txt'), 'nfc');
    scopes.grant(PLUGIN, [{ path: nfcScope, mode: 'r' }]);
    const nfd = join(root, 'cafe\u0301', 'in.txt');
    // 仅当文件系统确实不区分规范化形式、且 realpath 还原磁盘写法时才有意义(APFS)。
    const canonical = await realpath(nfd).catch(() => null);
    if (canonical === join(nfcScope, 'in.txt')) expect(await call(C.READ_FILE, nfd)).toBe('nfc');
  });
});

describe('经符号链接的 scope 根:插件用请求时的写法访问', () => {
  it('requestScope(链接路径)授予后,用同一写法读写可用;canonical 写法同样可用', async () => {
    const via = join(root, 'via-link');
    await symlink(scope, via);
    expect(await requestAndGrant(via, 'rw')).toBe('grant');
    expect(scopes.getScopes(PLUGIN)).toEqual([{ path: scope, mode: 'rw' }]);
    expect(await call(C.READ_FILE, join(via, 'in.txt'))).toBe('in');
    await call(C.WRITE_FILE, join(via, 'new.txt'), 'n');
    expect(await call(C.READ_FILE, join(scope, 'new.txt'))).toBe('n');
  });

  it('已有授权静默覆盖的请求同样登记写法(重启水合后的常见路径)', async () => {
    const via = join(root, 'via-link');
    await symlink(scope, via);
    scopes.grant(PLUGIN, [{ path: scope, mode: 'r' }]);
    expect(await call(C.REQUEST_SCOPE, [{ path: via, mode: 'r' }])).toBe('grant');
    expect(await call(C.READ_FILE, join(via, 'in.txt'))).toBe('in');
  });

  it('只读别名不放宽写:经链接写法写入只读 scope → 拒', async () => {
    const via = join(root, 'via-link');
    await symlink(scope, via);
    expect(await requestAndGrant(via, 'r')).toBe('grant');
    const realpathSpy = vi.spyOn(fsp, 'realpath');
    await expect(call(C.WRITE_FILE, join(via, 'x.txt'), 'x')).rejects.toThrow(/target not in any granted scope/);
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it('未经请求的链接写法(scope 外符号链接指向 scope 内)→ 拒(行为收紧)', async () => {
    const via = join(root, 'via-link');
    await symlink(scope, via);
    scopes.grant(PLUGIN, [{ path: scope, mode: 'r' }]);
    await expect(call(C.READ_FILE, join(via, 'in.txt'))).rejects.toThrow(/target not in any granted scope/);
  });

  it('卸载(revokeAll)后别名失效', async () => {
    const via = join(root, 'via-link');
    await symlink(scope, via);
    expect(await requestAndGrant(via, 'r')).toBe('grant');
    scopes.revokeAll(PLUGIN);
    scopes.grant(PLUGIN, [{ path: scope, mode: 'r' }]);
    await expect(call(C.READ_FILE, join(via, 'in.txt'))).rejects.toThrow(/target not in any granted scope/);
  });
});
