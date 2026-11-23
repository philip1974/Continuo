// 安全:requestScope 的路径含 `..` 且中间有不存在的分量时,弹窗显示、实际授予、登记的别名必须是同一个
// 折叠后的位置;不能显示「看似在工作区内」的写法却把别名登记成 `/`,让存在性探测器重开。行为见同目录 README。
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import { registerPluginFsHandlers } from '../../../electron/main/services/plugin-fs.service';
import { canonicalizeScopePath } from '../../../electron/main/services/path-resolve.helper';
import { StubIpcMain, makeFakeEvent } from '../sdk-contract/integration/make-stub-ipc';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') } }));

const PLUGIN = 'plugin.probe';
const C = PLUGIN_FS_CHANNELS;

let root: string; // canonical
let ws: string;
let outside: string;
let ipc: StubIpcMain;
let scopes: PathScopeRegistry;
let correlator: ScopeRequestCorrelator;
let token: string;
const event = makeFakeEvent({ id: 1, isDestroyed: () => false });

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

/** 发起 requestScope,返回弹窗 payload 里的 displayPath,并按 decision 应答。 */
async function requestScope(path: string, decision: 'grant' | 'deny'): Promise<{ result: unknown; displayPath: string }> {
  const before = event.sender.send.mock.calls.length;
  const pending = call(C.REQUEST_SCOPE, [{ path, mode: 'r' }]);
  await vi.waitFor(() => {
    if (event.sender.send.mock.calls.length === before) throw new Error('scope-request 未发出');
  });
  const [, payload] = event.sender.send.mock.calls[before]! as [
    string,
    { requestId: string; scopes: { displayPath: string }[] },
  ];
  await ipc.invokeWithEvent(event, C.SCOPE_DECISION, payload.requestId, decision);
  return { result: await pending, displayPath: payload.scopes[0]!.displayPath };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'scope-dotdot-')));
  ws = join(root, 'ws');
  outside = join(root, 'outside');
  await mkdir(ws);
  await mkdir(outside);
  await writeFile(join(outside, 'file.txt'), 'secret');
  ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  scopes = new PathScopeRegistry(identity);
  correlator = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
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

describe('canonicalizeScopePath:先折叠 `..` 再解析', () => {
  it('不存在的分量后跟 `..` → 折叠后的真实位置,不保留 `..`', async () => {
    expect(await canonicalizeScopePath(`${ws}/missing/../../outside`)).toBe(outside);
    expect(await canonicalizeScopePath(`${ws}/missing/..`)).toBe(ws);
  });

  it('一路 `..` 到根 → 文件系统根(POSIX `/`;Windows `C:\\`,不是驱动器相对的 `C:`)', async () => {
    const ups = root.split(sep).filter(Boolean).map(() => '..').join('/');
    expect(await canonicalizeScopePath(`${ws}/missing/../../${ups}`)).toBe(parse(root).root);
  });

  it('不含 `..` 的不存在目录 → 上级 realpath + 其余原样(行为不变)', async () => {
    expect(await canonicalizeScopePath(join(ws, 'a', 'b'))).toBe(join(ws, 'a', 'b'));
  });
});

describe('requestScope 含 `..` 的写法', () => {
  const escaping = (): string => `${ws}/missing/../../outside`;

  it('弹窗显示折叠后的真实位置(不是看似在工作区内的写法)', async () => {
    const { displayPath } = await requestScope(escaping(), 'deny');
    expect(displayPath).toBe(outside);
    expect(displayPath).not.toContain('..');
  });

  it('用户允许 → 授予的就是弹窗显示的位置,范围之外仍统一拒绝且不区分存在性', async () => {
    const { result, displayPath } = await requestScope(escaping(), 'grant');
    expect(result).toBe('grant');
    expect(scopes.getScopes(PLUGIN).map((s) => s.path)).toEqual([displayPath]);
    expect(await outcome(call(C.READ_FILE, join(outside, 'file.txt')))).toBe('ok');

    const existing = await outcome(call(C.STAT, join(ws, 'missing')));
    const missing = await outcome(call(C.STAT, join(root, 'nope')));
    const sibling = await outcome(call(C.STAT, ws));
    expect(existing).toContain('target not in any granted scope');
    expect(missing).toBe(existing);
    expect(sibling).toBe(existing);
  });

  it('已有工作区授权:含 `..` 逃出工作区的写法不被静默覆盖,也不登记成更宽的别名', async () => {
    scopes.grant(PLUGIN, [{ path: ws, mode: 'r' }]);
    const before = {
      exists: await outcome(call(C.STAT, join(outside, 'file.txt'))),
      missing: await outcome(call(C.STAT, join(outside, 'nope'))),
    };
    expect(before.missing).toBe(before.exists);

    // 修复前:canonical 保留成 `<ws>/missing/../../outside`,前缀落在已授 ws 下 → 不弹窗直接 grant,
    // 并把折叠后的 `<root>/outside` 登记为别名 → 其下路径通过词法预判,错误重新区分存在性。
    const { displayPath } = await requestScope(escaping(), 'deny');
    expect(displayPath).toBe(outside);

    const after = {
      exists: await outcome(call(C.STAT, join(outside, 'file.txt'))),
      missing: await outcome(call(C.STAT, join(outside, 'nope'))),
    };
    expect(after).toEqual(before);
  });
});

describe('noteRequestedRoots:不登记比 canonical 更宽的词法根', () => {
  it('canonical 含 `..` 分量(未折叠)→ 不登记别名', async () => {
    scopes.grant(PLUGIN, [{ path: ws, mode: 'r' }]);
    scopes.noteRequestedRoots(
      PLUGIN,
      [{ path: `${ws}/missing/../../outside`, mode: 'r' }],
      [{ path: `${ws}/missing/../../outside`, mode: 'r' }],
    );
    const exists = await outcome(call(C.STAT, join(outside, 'file.txt')));
    const missing = await outcome(call(C.STAT, join(outside, 'nope')));
    expect(exists).toContain('target not in any granted scope');
    expect(missing).toBe(exists);
  });
});
