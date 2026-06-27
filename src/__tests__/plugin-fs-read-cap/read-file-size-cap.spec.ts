// 边界(E28,E18 平行入口):plugin-fs:read-file 在 scope 校验后此前直接
// fs.readFile(.., 'utf-8'),没有像主 fs:read-file(E18)那样做 stat.size 上限。已授权插件
// 可让主进程整块读入超大文件再经 IPC 回 renderer → 内存峰值/卡死。修:复用主 fs:read-file 的
// readFile(读前 stat.size,超 64MiB 抛 FS_FILE_TOO_LARGE),与 write-file 复用 atomicWriteFile
//(R4)同手法 —— plugin-fs 是 Explorer fs 的平行入口,大文件读保护必须传播过来。

import {
  mkdtemp,
  rm,
  realpath,
  writeFile,
  truncate,
  readFile,
  access,
} from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS } from '../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../electron/main/services/scope-request-correlator';
import {
  registerPluginFsHandlers,
  MAX_LIST_DIR_ENTRIES,
  MAX_SCOPE_REQUEST_COUNT,
} from '../../../electron/main/services/plugin-fs.service';
import { promises as nodeFsPromises } from 'node:fs';
import {
  StubIpcMain,
  makeFakeEvent,
} from '../sdk-contract/integration/make-stub-ipc';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '') },
}));

let tmpRoot: string;
let tmpCanonical: string;
let ipc: StubIpcMain;
let scopes: PathScopeRegistry;
let correlator: ScopeRequestCorrelator;
let token: string;
const event = makeFakeEvent({ id: 1 });

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), `pfs-readcap-${randomUUID()}-`));
  tmpCanonical = await realpath(tmpRoot);
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
  const reg = (await ipc.invokeWithEvent(
    event,
    PLUGIN_FS_CHANNELS.REGISTER_PLUGIN,
    'plugin.fs',
  )) as { token: string };
  token = reg.token;
  scopes.grant('plugin.fs', [{ path: tmpCanonical, mode: 'rw' }]);
});

afterEach(async () => {
  correlator.dispose();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('E28 · plugin-fs:read-file 大小上限(E18 平行入口)', () => {
  it('普通小文件 → 正常读取内容', async () => {
    const f = join(tmpCanonical, 'ok.txt');
    await writeFile(f, 'hello-plugin');
    const content = await ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.READ_FILE,
      token,
      f,
    );
    expect(content).toBe('hello-plugin');
  });

  it('超 64MiB → 抛 FS_FILE_TOO_LARGE(读前 stat 拦截,不整文件读入)', async () => {
    const huge = join(tmpCanonical, 'huge.txt');
    await writeFile(huge, 'x');
    await truncate(huge, 64 * 1024 * 1024 + 1); // 稀疏扩展,不写 64MB 实际数据
    await expect(
      ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.READ_FILE, token, huge),
    ).rejects.toMatchObject({ code: 'FS_FILE_TOO_LARGE' });
  });

  it('读目标是目录 → 抛 FS_NOT_FILE(复用 E18 目录守卫)', async () => {
    await expect(
      ipc.invokeWithEvent(
        event,
        PLUGIN_FS_CHANNELS.READ_FILE,
        token,
        tmpCanonical,
      ),
    ).rejects.toMatchObject({ code: 'FS_NOT_FILE' });
  });
});

// 边界(E29,E13 平行入口 / E28 写侧 twin):plugin-fs:write-file 的 content 此前无大小上限,
// 直接进 atomicWriteFile。已授权插件可经单次 IPC 发超大字符串 → 主进程内存峰值 + 超大临时文件
// + fsync/rename 阻塞。修:复用主 fs:write-file 的 MAX_WRITE_BYTES(64MiB),进 atomicWriteFile
// 前拒绝超限,抛 FS_FILE_TOO_LARGE。
describe('E29 · plugin-fs:write-file 大小上限(E13 平行入口)', () => {
  it('正常 content → 正常写入', async () => {
    const f = join(tmpCanonical, 'w.txt');
    await ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.WRITE_FILE,
      token,
      f,
      'plugin-wrote-this',
    );
    expect(await readFile(f, 'utf8')).toBe('plugin-wrote-this');
  });

  it('content 超 64MiB → 抛 FS_FILE_TOO_LARGE,进 atomicWriteFile 前拒绝(不落盘)', async () => {
    const f = join(tmpCanonical, 'toobig.txt');
    const huge = 'x'.repeat(64 * 1024 * 1024 + 1); // 同 E13 写测试的分配方式
    await expect(
      ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.WRITE_FILE, token, f, huge),
    ).rejects.toMatchObject({ code: 'FS_FILE_TOO_LARGE' });
    // 拒绝在写之前 → 目标文件未创建,无超大临时文件落盘。
    await expect(access(f)).rejects.toThrow();
  });
});

// 边界(E30,plugin-fs 平行入口):list-dir 此前 fs.readdir 整目录全量返回,无条目数上限。
// 已授权插件对超大目录调 listDir → 主进程一次性构造巨大数组并经 IPC 全量返回 → 内存/CPU/IPC 卡顿。
// 修:opendir 惰性迭代,累计到硬上限即 fail-closed 抛 FS_DIR_TOO_LARGE(不静默截断)。
describe('E30 · plugin-fs:list-dir 条目数硬上限', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('正常目录 → 正常返回条目', async () => {
    await writeFile(join(tmpCanonical, 'a.txt'), '1');
    await writeFile(join(tmpCanonical, 'b.txt'), '2');
    const entries = (await ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.LIST_DIR,
      token,
      tmpCanonical,
    )) as { name: string }[];
    expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('源码守卫:热路径单项追加不通过 out.push 调用', () => {
    const source = readFileSync(
      join(process.cwd(), 'electron/main/services/plugin-fs.service.ts'),
      'utf8',
    );
    expect(source).not.toContain('out.push({');
  });

  it('条目数超硬上限 → 抛 FS_DIR_TOO_LARGE(惰性迭代,不静默截断)', async () => {
    // 用惰性 fake Dir 产生 cap+1 个条目,免真实创建 10 万文件;opendir 被 spy 拦截。
    const fakeDir = {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i <= MAX_LIST_DIR_ENTRIES; i += 1) {
          yield {
            name: `f${i}`,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          };
        }
      },
    };
    vi.spyOn(nodeFsPromises, 'opendir').mockResolvedValue(
      fakeDir as unknown as Awaited<ReturnType<typeof nodeFsPromises.opendir>>,
    );
    await expect(
      ipc.invokeWithEvent(
        event,
        PLUGIN_FS_CHANNELS.LIST_DIR,
        token,
        tmpCanonical,
      ),
    ).rejects.toMatchObject({ code: 'FS_DIR_TOO_LARGE' });
  });
});

// 边界(E31,IPC payload 校验族 E11/E12/E16/E17/E23):request-scope 的 scopes 是插件直传,此前
// 无运行时校验就批量 canonicalize + 发弹窗 + 可能进 registry/persist。畸形插件可传超大数组/超长
// 路径/非法 mode。入口 fail-closed 校验数量/路径长度/mode 枚举,超限直接拒绝(不进 canonicalize)。
describe('E31 · plugin-fs:request-scope 入口校验', () => {
  it('合法 scope(已授权覆盖)→ grant(校验通过)', async () => {
    const decision = await ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.REQUEST_SCOPE,
      token,
      [{ path: tmpCanonical, mode: 'r' }],
    );
    expect(decision).toBe('grant');
  });

  it('scopes 数量超上限 → 抛 BAD_INPUT(不进 canonicalize/弹窗)', async () => {
    const tooMany = Array.from({ length: MAX_SCOPE_REQUEST_COUNT + 1 }, () => ({
      path: tmpCanonical,
      mode: 'r' as const,
    }));
    await expect(
      ipc.invokeWithEvent(
        event,
        PLUGIN_FS_CHANNELS.REQUEST_SCOPE,
        token,
        tooMany,
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('scope 路径超长(>8192)→ 抛 BAD_INPUT', async () => {
    await expect(
      ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.REQUEST_SCOPE, token, [
        { path: '/' + 'x'.repeat(8193), mode: 'r' },
      ]),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('非法 mode → 抛 BAD_INPUT(不污染 registry/persist)', async () => {
    await expect(
      ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.REQUEST_SCOPE, token, [
        { path: tmpCanonical, mode: 'admin' },
      ]),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});

// 边界(E63):plugin-fs:read-git-blob 的 sha 是插件直传,进 git cat-file argv 前先校验固定 hex
// 形态 + 长度(挡超长 sha 触发 spawn E2BIG / argv 内存放大;非 hex 直接拒,不进 spawn)。
describe('E63 · plugin-fs:read-git-blob sha 校验', () => {
  it('超长 sha(>64 hex)→ 抛,不进 spawn', async () => {
    await expect(
      ipc.invokeWithEvent(
        event,
        PLUGIN_FS_CHANNELS.READ_GIT_BLOB,
        token,
        tmpCanonical,
        'a'.repeat(65),
      ),
    ).rejects.toThrow(/invalid git blob sha/i);
  });

  it('非 hex sha → 抛', async () => {
    await expect(
      ipc.invokeWithEvent(
        event,
        PLUGIN_FS_CHANNELS.READ_GIT_BLOB,
        token,
        tmpCanonical,
        'not-a-sha; rm -rf /',
      ),
    ).rejects.toThrow(/invalid git blob sha/i);
  });

  it('空 sha → 抛', async () => {
    await expect(
      ipc.invokeWithEvent(
        event,
        PLUGIN_FS_CHANNELS.READ_GIT_BLOB,
        token,
        tmpCanonical,
        '',
      ),
    ).rejects.toThrow(/invalid git blob sha/i);
  });
});

// 边界(E96):plugin-fs:scope-decision 入口校验 requestId(非空 + 长度上限)+ decision(enum)。
// 裸 handle 此前无 schema 校验,超长 requestId 经 ScopeRequestTimeoutError/IPC/toast 放大,
// 非法 decision 命中 pending 破坏授权契约。非法 → BAD_INPUT,不把原始 requestId 拼进错误。
describe('E96 · plugin-fs:scope-decision 入口校验', () => {
  it('超长 requestId(>256)→ BAD_INPUT 且不回显原串', async () => {
    const longId = 'r'.repeat(300);
    const err = await ipc
      .invokeWithEvent(event, PLUGIN_FS_CHANNELS.SCOPE_DECISION, longId, 'grant')
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('BAD_INPUT');
    expect(String((err as Error).message)).not.toContain(longId); // 不回显超长 requestId
  });

  it('空 requestId → BAD_INPUT', async () => {
    await expect(
      ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.SCOPE_DECISION, '', 'grant'),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('非法 decision(非 grant/deny)→ BAD_INPUT', async () => {
    await expect(
      ipc.invokeWithEvent(
        event,
        PLUGIN_FS_CHANNELS.SCOPE_DECISION,
        'req-1',
        'malicious',
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('合法 requestId + decision → 通过入口校验进入 correlator(非 BAD_INPUT)', async () => {
    const err = await ipc
      .invokeWithEvent(
        event,
        PLUGIN_FS_CHANNELS.SCOPE_DECISION,
        'req-unknown',
        'deny',
      )
      .catch((e: unknown) => e);
    // 未知 requestId → correlator 抛 ScopeRequestTimeoutError(既有行为),但**不是** BAD_INPUT:
    // 证明合法格式输入已通过入口校验进入 resolve(校验只拦非法格式/非枚举,不误拦合法值)。
    expect((err as { code?: string }).code).not.toBe('BAD_INPUT');
  });
});

// 边界(E97):plugin-fs:_register-plugin 注册入口校验 pluginId(isSafePluginId + 长度上限),
// 绕过 manifest id 正则 + E86/E87 持久化 canonicalize 前门的超长/非法 id 在此 fail-closed。
describe('E97 · plugin-fs:_register-plugin pluginId 校验', () => {
  it('合法 pluginId → 注册成功(返 token)', async () => {
    const reg = (await ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.REGISTER_PLUGIN,
      'com.legit',
    )) as { token: string };
    expect(typeof reg.token).toBe('string');
    expect(reg.token.length).toBeGreaterThan(0);
  });

  it('超长 pluginId(>256)→ BAD_INPUT,不进 registry', async () => {
    await expect(
      ipc.invokeWithEvent(
        event,
        PLUGIN_FS_CHANNELS.REGISTER_PLUGIN,
        'a'.repeat(257),
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('非法字符 pluginId(大写/空格)→ BAD_INPUT', async () => {
    await expect(
      ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.REGISTER_PLUGIN, 'Bad Id'),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('路径穿越 pluginId(..)→ BAD_INPUT', async () => {
    await expect(
      ipc.invokeWithEvent(event, PLUGIN_FS_CHANNELS.REGISTER_PLUGIN, '..'),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});
