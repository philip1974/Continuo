// 安全:plugin-fs 的「scope 校验 → 实际文件系统操作」不是原子的(Node 无 openat)。插件可用自己的变更调用
// (rename / atomicReplaceWithinScope …)在另一次调用的校验与操作之间,把路径上的某一级目录换成指向 scope 外的
// 既有符号链接。全局读写锁让变更类调用无法落在任何其它调用的校验与操作之间。行为见同目录 README。
//
// 做法:真实 IPC handler + 真实 PathScopeRegistry + 真实临时目录;在「校验之后、操作之前」的系统调用上挂钩子
// (vi.spyOn node:fs promises / vi.mock 写入器),钩子里并发发起另一条调用并等一小段时间,观察它是否被挡在外面。
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hook = vi.hoisted(() => ({ beforeWrite: null as (() => Promise<void>) | null }));

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') } }));
vi.mock('../../../electron/main/ipc/fs/atomic-write', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../electron/main/ipc/fs/atomic-write')>();
  return {
    ...orig,
    atomicReplaceFileNoFollow: async (...args: Parameters<typeof orig.atomicReplaceFileNoFollow>) => {
      const h = hook.beforeWrite;
      hook.beforeWrite = null;
      await h?.();
      return orig.atomicReplaceFileNoFollow(...args);
    },
  };
});

const { PLUGIN_FS_CHANNELS: C } = await import('../../../electron/shared/plugin-fs-channels');
const { IdentityRegistry } = await import('../../../electron/main/services/identity-registry.service');
const { PathScopeRegistry } = await import('../../../electron/main/services/path-scope-registry.service');
const { ScopeRequestCorrelator } = await import('../../../electron/main/services/scope-request-correlator');
const { registerPluginFsHandlers, MAX_CP_ENTRIES } = await import('../../../electron/main/services/plugin-fs.service');
const { StubIpcMain, makeFakeEvent } = await import('../sdk-contract/integration/make-stub-ipc');

const PLUGIN = 'plugin.lock';
const SECRET = 'outside secret\n';
/** 钩子里等待的时长:无锁时一次 rename / atomicReplace(几次系统调用)远早于此完成。 */
const GAP_MS = 40;
let root: string;
let proj: string; // rw scope
let outDir: string; // scope 外
let ipc: InstanceType<typeof StubIpcMain>;
let correlator: InstanceType<typeof ScopeRequestCorrelator>;
let token: string;
const event = makeFakeEvent({ id: 1, isDestroyed: () => false });

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  ipc.invokeWithEvent(event, channel, token, ...args);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const exists = (p: string): Promise<boolean> =>
  lstat(p).then(
    () => true,
    () => false,
  );

type FspMethod = 'realpath' | 'open' | 'stat' | 'lstat' | 'opendir' | 'readdir' | 'cp' | 'mkdir' | 'rm' | 'rename' | 'access';

/** 在 fsp[method] 首次以 pathPart 结尾的路径被调用时(= 受害调用的校验之后、操作之前)先跑一次 inGap。 */
function hookFsOnce(method: FspMethod, pathSuffix: string, inGap: () => Promise<void>): void {
  const real = (fsp[method] as (...a: unknown[]) => Promise<unknown>).bind(fsp);
  let fired = false;
  vi.spyOn(fsp, method as 'stat').mockImplementation((async (...a: unknown[]) => {
    if (!fired && typeof a[0] === 'string' && a[0].endsWith(pathSuffix)) {
      fired = true;
      await inGap();
    }
    return real(...a);
  }) as never);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pfs-rwlock-')));
  proj = join(root, 'proj');
  outDir = join(root, 'outdir');
  await mkdir(proj);
  await mkdir(outDir);
  await writeFile(join(outDir, 'f'), SECRET);
  ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  const scopes = new PathScopeRegistry(identity);
  correlator = new ScopeRequestCorrelator({ ttlMs: 60_000, gcIntervalMs: 60_000 });
  registerPluginFsHandlers(ipc as never, {
    identityRegistry: identity,
    pathScopeRegistry: scopes,
    correlator,
  });
  token = ((await ipc.invokeWithEvent(event, C.REGISTER_PLUGIN, PLUGIN)) as { token: string }).token;
  scopes.grant(PLUGIN, [{ path: proj, mode: 'rw' }]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  hook.beforeWrite = null;
  vi.restoreAllMocks();
  correlator.dispose();
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('攻击复现:校验与操作之间把目录分量换成指向 scope 外的既有链接', () => {
  // proj/d 是真目录(d/f = inside);proj/dl 是既有的、指向 scope 外目录的链接(SDK 没有建链接的 API,只能挪既有的)。
  async function layout(): Promise<{ swapByRename: () => Promise<void> }> {
    await mkdir(join(proj, 'd'));
    await writeFile(join(proj, 'd', 'f'), 'inside');
    await symlink(outDir, join(proj, 'dl'));
    return {
      swapByRename: async () => {
        await invoke(C.RENAME, join(proj, 'd'), join(proj, 'dbak'));
        await invoke(C.RENAME, join(proj, 'dl'), join(proj, 'd'));
      },
    };
  }

  it('cp:并发 rename 换入外链 → 拷出的是 scope 内的内容,换入发生在 cp 之后', async () => {
    const { swapByRename } = await layout();
    let swap: Promise<void> | undefined;
    hookFsOnce('cp', join('d', 'f'), async () => {
      swap = swapByRename();
      await sleep(GAP_MS);
    });
    await invoke(C.CP, join(proj, 'd', 'f'), join(proj, 'copy'));
    expect(await readFile(join(proj, 'copy'), 'utf-8')).toBe('inside');
    await swap;
    expect((await lstat(join(proj, 'd'))).isSymbolicLink()).toBe(true); // 换入本身照常完成,只是排在后面
  });

  it('readFile:并发 atomicReplace 把含外链的目录 P 换到被读的目录 Q 上 → 读到的是 scope 内的内容', async () => {
    const P = join(proj, 'P');
    const Q = join(proj, 'Q');
    await mkdir(P);
    await mkdir(join(Q, 'dl'), { recursive: true });
    await symlink(outDir, join(P, 'dl'));
    await writeFile(join(Q, 'dl', 'f'), 'inside');
    let swap: Promise<unknown> | undefined;
    hookFsOnce('open', join('Q', 'dl', 'f'), async () => {
      swap = invoke(C.ATOMIC_REPLACE, P, Q, { overwrite: true });
      await sleep(GAP_MS);
    });
    expect(await invoke(C.READ_FILE, join(Q, 'dl', 'f'))).toBe('inside');
    await swap;
    expect((await lstat(join(Q, 'dl'))).isSymbolicLink()).toBe(true);
  });

  it('writeFile:并发 rename 换入外链 → 内容落在 scope 内,scope 外目录没有新文件', async () => {
    const { swapByRename } = await layout();
    let swap: Promise<void> | undefined;
    hook.beforeWrite = async () => {
      swap = swapByRename();
      await sleep(GAP_MS);
    };
    await invoke(C.WRITE_FILE, join(proj, 'd', 'w'), 'plugin data');
    await swap;
    expect(await exists(join(outDir, 'w'))).toBe(false);
    expect(await readFile(join(proj, 'dbak', 'w'), 'utf-8')).toBe('plugin data');
  });

  it('mkdir:并发 atomicReplace 换入外链 → 目录建在 scope 内,scope 外没有新目录', async () => {
    const P = join(proj, 'P');
    const Q = join(proj, 'Q');
    await mkdir(P);
    await mkdir(join(Q, 'dl'), { recursive: true });
    await symlink(outDir, join(P, 'dl'));
    let swap: Promise<unknown> | undefined;
    hookFsOnce('mkdir', join('Q', 'dl', 'm'), async () => {
      swap = invoke(C.ATOMIC_REPLACE, P, Q, { overwrite: true });
      await sleep(GAP_MS);
    });
    await invoke(C.MKDIR, join(Q, 'dl', 'm'));
    await swap;
    expect(await exists(join(outDir, 'm'))).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('互斥矩阵', () => {
  /** arm:在该调用的「校验后、操作前」挂一次钩子;run:发起调用。 */
  interface Op {
    name: string;
    arm: (inGap: () => Promise<void>) => void;
    run: () => Promise<unknown>;
  }
  const p = (...s: string[]): string => join(proj, ...s);
  const victims: Op[] = [
    { name: 'readFile', arm: (g) => hookFsOnce('open', 'v.txt', g), run: () => invoke(C.READ_FILE, p('v.txt')) },
    { name: 'stat', arm: (g) => hookFsOnce('stat', 'v.txt', g), run: () => invoke(C.STAT, p('v.txt')) },
    { name: 'lstat', arm: (g) => hookFsOnce('lstat', 'v.txt', g), run: () => invoke(C.LSTAT, p('v.txt')) },
    { name: 'listDir', arm: (g) => hookFsOnce('opendir', 'vdir', g), run: () => invoke(C.LIST_DIR, p('vdir')) },
    { name: 'cp', arm: (g) => hookFsOnce('cp', 'v.txt', g), run: () => invoke(C.CP, p('v.txt'), p('v-copy.txt')) },
    { name: 'writeFile', arm: (g) => (hook.beforeWrite = g), run: () => invoke(C.WRITE_FILE, p('v-new.txt'), 'x') },
    { name: 'mkdir', arm: (g) => hookFsOnce('mkdir', 'v-newdir', g), run: () => invoke(C.MKDIR, p('v-newdir')) },
    { name: 'rm', arm: (g) => hookFsOnce('rm', 'v.txt', g), run: () => invoke(C.RM, p('v.txt')) },
    { name: 'rename', arm: (g) => hookFsOnce('rename', 'v.txt', g), run: () => invoke(C.RENAME, p('v.txt'), p('v2.txt')) },
    {
      name: 'atomicReplaceWithinScope',
      arm: (g) => hookFsOnce('access', 'v-final.txt', g),
      run: () => invoke(C.ATOMIC_REPLACE, p('v.txt'), p('v-final.txt')),
    },
    {
      // 对象库校验(读 pack 目录)在 scope 校验之后、git cat-file 之前;sha 不存在,调用本身以失败告终。
      name: 'readGitBlob',
      arm: (g) => {
        execFileSync('git', ['init', '-q', p('repo')]);
        hookFsOnce('readdir', 'pack', g);
      },
      run: () => invoke(C.READ_GIT_BLOB, p('repo'), '0'.repeat(40)).catch(() => undefined),
    },
  ];
  // 变更类调用:完成的可观察标志是 done 路径出现。
  const mutators: { name: string; run: () => Promise<unknown>; done: string }[] = [
    { name: 'writeFile', run: () => invoke(C.WRITE_FILE, p('m-w.txt'), 'x'), done: 'm-w.txt' },
    { name: 'mkdir', run: () => invoke(C.MKDIR, p('m-dir')), done: 'm-dir' },
    { name: 'rename', run: () => invoke(C.RENAME, p('m.txt'), p('m-renamed.txt')), done: 'm-renamed.txt' },
    { name: 'cp', run: () => invoke(C.CP, p('m.txt'), p('m-copy.txt')), done: 'm-copy.txt' },
    {
      name: 'atomicReplaceWithinScope',
      run: () => invoke(C.ATOMIC_REPLACE, p('m.txt'), p('m-final.txt')),
      done: 'm-final.txt',
    },
  ];

  beforeEach(async () => {
    await writeFile(p('v.txt'), 'victim');
    await writeFile(p('m.txt'), 'mutator');
    await writeFile(p('m-rm.txt'), 'to remove');
    await mkdir(p('vdir'));
  });

  it.each(victims)('$name 处于校验与操作之间时,并发的变更调用(rename)被挡到它完成之后', async (victim) => {
    let mutation: Promise<unknown> | undefined;
    let doneInGap: boolean | undefined;
    victim.arm(async () => {
      mutation = invoke(C.RENAME, p('m.txt'), p('m-renamed.txt'));
      await sleep(GAP_MS);
      doneInGap = await exists(p('m-renamed.txt'));
    });
    await victim.run();
    expect(doneInGap).toBe(false);
    await mutation;
    expect(await exists(p('m-renamed.txt'))).toBe(true);
  });

  it.each(mutators)('readFile 处于校验与操作之间时,变更调用 $name 被挡在外面', async (mutator) => {
    let mutation: Promise<unknown> | undefined;
    let doneInGap: boolean | undefined;
    hookFsOnce('open', 'v.txt', async () => {
      mutation = mutator.run();
      await sleep(GAP_MS);
      doneInGap = await exists(p(mutator.done));
    });
    expect(await invoke(C.READ_FILE, p('v.txt'))).toBe('victim');
    expect(doneInGap).toBe(false);
    await mutation;
    expect(await exists(p(mutator.done))).toBe(true);
  });

  it('readFile 处于校验与操作之间时,变更调用 rm 被挡在外面', async () => {
    let mutation: Promise<unknown> | undefined;
    let goneInGap: boolean | undefined;
    hookFsOnce('open', 'v.txt', async () => {
      mutation = invoke(C.RM, p('m-rm.txt'));
      await sleep(GAP_MS);
      goneInGap = !(await exists(p('m-rm.txt')));
    });
    await invoke(C.READ_FILE, p('v.txt'));
    expect(goneInGap).toBe(false);
    await mutation;
    expect(await exists(p('m-rm.txt'))).toBe(false);
  });

  it('只读调用之间不互斥:readFile 处于校验与操作之间时,stat / lstat / listDir / realpath / readFile 照常完成', async () => {
    let results: unknown[] | undefined;
    hookFsOnce('open', 'v.txt', async () => {
      results = await Promise.all([
        invoke(C.STAT, p('m.txt')),
        invoke(C.LSTAT, p('m.txt')),
        invoke(C.LIST_DIR, p('vdir')),
        invoke(C.REALPATH, p('m.txt')),
        invoke(C.READ_FILE, p('m.txt')),
      ]);
    });
    expect(await invoke(C.READ_FILE, p('v.txt'))).toBe('victim');
    expect(results?.[3]).toBe(p('m.txt'));
    expect(results?.[4]).toBe('mutator');
  });

  it('调用抛错后锁被释放:失败的读 / 写之后,后续读写照常', async () => {
    await expect(invoke(C.READ_FILE, p('no-such.txt'))).rejects.toThrow();
    await expect(invoke(C.RENAME, p('no-such.txt'), p('x.txt'))).rejects.toThrow();
    await expect(invoke(C.CP, p('v.txt'), p('m.txt'))).rejects.toThrow(/already exists/);
    await invoke(C.WRITE_FILE, p('after.txt'), 'ok');
    expect(await invoke(C.READ_FILE, p('after.txt'))).toBe('ok');
  });

  it('cp 的条目总数有上限(限定最坏持锁时间):超限以 FS_DIR_TOO_LARGE 中止', async () => {
    const cp = vi.spyOn(fsp, 'cp').mockImplementation(async (_s, _d, o) => {
      for (let i = 0; i <= MAX_CP_ENTRIES; i += 1) await o!.filter!('s', 'd');
    });
    await expect(invoke(C.CP, p('vdir'), p('vdir-copy'), { recursive: true })).rejects.toMatchObject({
      code: 'FS_DIR_TOO_LARGE',
    });
    cp.mockRestore();
    await mkdir(p('vdir', 'sub'));
    await writeFile(p('vdir', 'sub', 'f'), 'deep');
    await invoke(C.CP, p('vdir'), p('vdir-copy'), { recursive: true });
    expect(await readFile(p('vdir-copy', 'sub', 'f'), 'utf-8')).toBe('deep');
  });

  it('requestScope 等待用户决定期间不持锁:读写照常', async () => {
    const pending = invoke(C.REQUEST_SCOPE, [{ path: outDir, mode: 'r' }]);
    await vi.waitFor(() => expect(event.sender.send).toHaveBeenCalled());
    await invoke(C.WRITE_FILE, p('during-prompt.txt'), 'ok');
    expect(await invoke(C.READ_FILE, p('during-prompt.txt'))).toBe('ok');
    const { requestId } = event.sender.send.mock.calls.at(-1)![1] as { requestId: string };
    await ipc.invokeWithEvent(event, C.SCOPE_DECISION, requestId, 'deny');
    expect(await pending).toBe('deny');
  });
});

describe.skipIf(process.platform === 'win32')('纵深:readFile 经「打开后复核」的 fd 读取(锁管不到的外部改动)', () => {
  it('校验之后目录分量被外部换成指向 scope 外的链接 → 拒绝,读不到 scope 外内容', async () => {
    await mkdir(join(proj, 'd'));
    await writeFile(join(proj, 'd', 'f'), 'inside');
    hookFsOnce('open', join('d', 'f'), async () => {
      // 不经 plugin-fs(模拟有 shell 权限的插件 / 其它进程)直接改盘
      await fsp.rename(join(proj, 'd'), join(proj, 'dbak'));
      await symlink(outDir, join(proj, 'd'));
    });
    await expect(invoke(C.READ_FILE, join(proj, 'd', 'f'))).rejects.toThrow(/not in any granted scope/);
  });

  it('校验之后叶子被外部换成指向 scope 外的链接 → 拒绝', async () => {
    await writeFile(join(proj, 'x'), 'inside');
    hookFsOnce('open', 'x', async () => {
      await rm(join(proj, 'x'));
      await symlink(join(outDir, 'f'), join(proj, 'x'));
    });
    await expect(invoke(C.READ_FILE, join(proj, 'x'))).rejects.toThrow(/not in any granted scope/);
  });

  it('打开时是外链、复核前又被换回 → 打开的不是复核到的那个文件,不返回其内容(重试后读到 scope 内的文件)', async () => {
    await mkdir(join(proj, 'd'));
    await writeFile(join(proj, 'd', 'f'), 'inside');
    hookFsOnce('open', join('d', 'f'), async () => {
      await fsp.rename(join(proj, 'd'), join(proj, 'dbak'));
      await symlink(outDir, join(proj, 'd'));
      // 复核的第一步是 realpath:在它之前换回
      hookFsOnce('realpath', join('d', 'f'), async () => {
        await rm(join(proj, 'd'));
        await fsp.rename(join(proj, 'dbak'), join(proj, 'd'));
      });
    });
    expect(await invoke(C.READ_FILE, join(proj, 'd', 'f'))).toBe('inside');
  });

  it('文件在打开与复核之间反复被替换(每次都是新 inode)→ 重试一次后拒绝', async () => {
    const x = join(proj, 'x');
    await writeFile(x, 'v0');
    const real = fsp.open.bind(fsp);
    let n = 0;
    vi.spyOn(fsp, 'open').mockImplementation(async (...a) => {
      const fh = await real(...a);
      if (a[0] === x) {
        // 旧文件保留(inode 不被复用),路径换成新文件
        await fsp.rename(x, join(proj, `x-old-${(n += 1)}`));
        await writeFile(x, `v${n}`);
      }
      return fh;
    });
    await expect(invoke(C.READ_FILE, x)).rejects.toThrow(/changed during access/);
    expect(n).toBe(2);
  });

  it('正常读取不受影响:普通文件、经链接读 scope 内文件、硬链接;目录仍报不是文件', async () => {
    await writeFile(join(proj, 'a.txt'), 'A');
    await symlink(join(proj, 'a.txt'), join(proj, 'a-link'));
    await fsp.link(join(proj, 'a.txt'), join(proj, 'a-hard'));
    expect(await invoke(C.READ_FILE, join(proj, 'a.txt'))).toBe('A');
    expect(await invoke(C.READ_FILE, join(proj, 'a-link'))).toBe('A');
    expect(await invoke(C.READ_FILE, join(proj, 'a-hard'))).toBe('A');
    await expect(invoke(C.READ_FILE, proj)).rejects.toMatchObject({ code: 'FS_NOT_FILE' });
  });
});
