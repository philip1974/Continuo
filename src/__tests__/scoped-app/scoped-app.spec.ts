// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const coApiMocks = vi.hoisted(() => {
  const stat = {
    size: 0,
    mtimeMs: 0,
    isFile: true,
    isDirectory: false,
    isSymlink: false,
  };
  return {
    shellExec: vi.fn(),
    pluginFsRaw: {
      _registerPlugin: vi.fn().mockResolvedValue({
        token: 'test-token',
        generation: 1,
      }),
      _unregisterPlugin: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue('mock content'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      listDir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue(stat),
      lstat: vi.fn().mockResolvedValue(stat),
      realpath: vi.fn(async (p: string) => p),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      cp: vi.fn().mockResolvedValue(undefined),
      readGitBlob: vi.fn().mockResolvedValue(new Uint8Array()),
      atomicReplaceWithinScope: vi.fn().mockResolvedValue(undefined),
      requestScope: vi.fn().mockResolvedValue('grant'),
      _scopeDecision: vi.fn().mockResolvedValue(undefined),
      onScopeRequest: vi.fn(() => () => {}),
      onScopeUpdated: vi.fn(() => () => {}),
    },
    pluginShellStreamRaw: {
      execStream: vi.fn(() => ({
        chunks: {
          async *[Symbol.asyncIterator]() {},
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
      })),
    },
  };
});

vi.mock('@/lib/co-api', () => ({
  coApi: {
    shell: {
      exec: coApiMocks.shellExec,
    },
    pluginFsRaw: coApiMocks.pluginFsRaw,
    pluginShellStreamRaw: coApiMocks.pluginShellStreamRaw,
  },
}));

// 边界(E264):mock sandbox-sweep 的 getCachedFetch,使 network.fetch happy-path 不依赖 jsdom 真实 fetch。
const sandboxMocks = vi.hoisted(() => ({ fetch: vi.fn(async () => ({ ok: true })) }));
vi.mock('../../plugins/sandbox-sweep', () => ({
  getCachedFetch: () => sandboxMocks.fetch,
  getCachedClipboard: () => ({
    readText: async () => '',
    writeText: async () => {},
  }),
}));

function beforeEachClear(): void {
  beforeEach(() => {
    delete (window as { api?: unknown }).api;
    vi.clearAllMocks();
    coApiMocks.pluginFsRaw._registerPlugin.mockResolvedValue({
      token: 'test-token',
      generation: 1,
    });
    coApiMocks.pluginFsRaw._unregisterPlugin.mockResolvedValue(undefined);
    coApiMocks.pluginFsRaw.readFile.mockResolvedValue('mock content');
    coApiMocks.pluginFsRaw.writeFile.mockResolvedValue(undefined);
    coApiMocks.pluginFsRaw.listDir.mockResolvedValue([]);
    coApiMocks.pluginFsRaw.requestScope.mockResolvedValue('grant');
    coApiMocks.shellExec.mockResolvedValue({
      ok: true,
      data: { stdout: 'hi', stderr: '', exitCode: 0 },
    });
  });
}
function afterEachClear(): void {
  afterEach(() => {
    delete (window as { api?: unknown }).api;
    vi.restoreAllMocks();
  });
}
import {
  areValidShellArgs,
  buildPluginListDirEntries,
  createScopedApp,
  hasGrantedPermissionDecision,
} from '../../plugins/scoped-app';
import {
  MAX_WRITE_BYTES,
  FS_PATH_MAX,
  MAX_SCOPE_REQUEST_COUNT,
} from '../../../electron/shared/fs-limits';
import {
  NETWORK_URL_MAX,
  NETWORK_HEADERS_MAX,
  NETWORK_HEADER_VALUE_MAX,
} from '../../../electron/shared/network-limits';
import {
  InMemoryPermissionStore,
  PermissionError,
} from '../../plugins/permissions';
import type { CoApp } from '../../plugins/types';
import {
  PluginMcpRegistry,
  type PluginMcpUpstream,
} from '../../plugins/registries/PluginMcpRegistry';
import { createTestCoApp } from '../../plugins/test-utils';

const noopMcpUpstream: PluginMcpUpstream = {
  async register() {},
  async unregister() {},
};

function makeLmApp(): CoApp {
  return {
    ...createTestCoApp('1.0.0'),
    mcp: new PluginMcpRegistry(noopMcpUpstream),
  };
}

describe('createScopedApp 基础结构', () => {
  it('包含 fs / network / shell / clipboard / permission 5 个新字段', () => {
    const scoped = createScopedApp(makeLmApp(), 'p1', null);
    expect(typeof scoped.fs.readFile).toBe('function');
    expect(typeof scoped.network.fetch).toBe('function');
    expect(scoped.shell).toBeDefined();
    expect(typeof scoped.clipboard.readText).toBe('function');
    expect(typeof scoped.permission.check).toBe('function');
  });

  it('贡献点 registry 透传引用(两个 plugin 看到同一个 commands)', () => {
    const coApp = makeLmApp();
    const a = createScopedApp(coApp, 'p.a', null);
    const b = createScopedApp(coApp, 'p.b', null);
    expect(a.commands).toBe(coApp.commands);
    expect(b.commands).toBe(coApp.commands);
    expect(a.commands).toBe(b.commands);
  });

  it('fs / clipboard / permission 是 per-plugin 闭包(不同引用)', () => {
    const coApp = makeLmApp();
    const a = createScopedApp(coApp, 'p.a', null);
    const b = createScopedApp(coApp, 'p.b', null);
    expect(a.fs).not.toBe(b.fs);
    expect(a.permission).not.toBe(b.permission);
  });
});

// 边界(E264,E46/E180 pre-call 预检族):app.network.fetch 调 raw fetch 前校验 URL/headers。
// network 此前是唯一无输入边界闸的能力。超限抛 BAD_INPUT、不调 fetch。
describe('network.fetch 输入边界 (E264)', () => {
  it('超长 URL → 抛 BAD_INPUT,不调 fetch', async () => {
    const scoped = createScopedApp(makeLmApp(), 'p', null);
    sandboxMocks.fetch.mockClear();
    const longUrl = 'https://x/' + 'a'.repeat(NETWORK_URL_MAX);
    await expect(scoped.network.fetch(longUrl)).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
    expect(sandboxMocks.fetch).not.toHaveBeenCalled();
  });

  it('非 string URL / 空 URL → 抛 BAD_INPUT', async () => {
    const scoped = createScopedApp(makeLmApp(), 'p', null);
    await expect(
      scoped.network.fetch(123 as unknown as string),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(scoped.network.fetch('')).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
  });

  it('headers 条数超 NETWORK_HEADERS_MAX → 抛 BAD_INPUT,不调 fetch', async () => {
    const scoped = createScopedApp(makeLmApp(), 'p', null);
    sandboxMocks.fetch.mockClear();
    const headers: Record<string, string> = {};
    for (let i = 0; i <= NETWORK_HEADERS_MAX; i += 1) headers[`h${i}`] = 'v';
    await expect(
      scoped.network.fetch('https://x/', { headers }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(sandboxMocks.fetch).not.toHaveBeenCalled();
  });

  it('单 header value 超 NETWORK_HEADER_VALUE_MAX → 抛 BAD_INPUT', async () => {
    const scoped = createScopedApp(makeLmApp(), 'p', null);
    await expect(
      scoped.network.fetch('https://x/', {
        headers: { auth: 'v'.repeat(NETWORK_HEADER_VALUE_MAX + 1) },
      }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  // 边界(E269,E264 自引入缺口):非 string header key/value 此前绕过长度校验 → fetch/Headers 隐式
  // String() 在 raw fetch 边界再触发超长转换。要求 key/value 都是 string,非 string 直接拒。
  it('E269 非 string header value(toString 返超长)→ BAD_INPUT,不调 fetch', async () => {
    const scoped = createScopedApp(makeLmApp(), 'p', null);
    sandboxMocks.fetch.mockClear();
    const evilValue = {
      toString() {
        return 'v'.repeat(NETWORK_HEADER_VALUE_MAX + 1);
      },
    };
    await expect(
      scoped.network.fetch('https://x/', {
        headers: [['auth', evilValue as unknown as string]],
      }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(sandboxMocks.fetch).not.toHaveBeenCalled();
  });

  it('E269 非 string header value(number/object)→ BAD_INPUT', async () => {
    const scoped = createScopedApp(makeLmApp(), 'p', null);
    await expect(
      scoped.network.fetch('https://x/', {
        headers: { n: 123 as unknown as string },
      }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(
      scoped.network.fetch('https://x/', {
        headers: [['k', { a: 1 } as unknown as string]],
      }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('E269 非 string header key(数组分支)→ BAD_INPUT', async () => {
    const scoped = createScopedApp(makeLmApp(), 'p', null);
    await expect(
      scoped.network.fetch('https://x/', {
        headers: [[{ k: 1 } as unknown as string, 'v']],
      }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('合法 URL + headers → 通过预检并调 fetch(回归)', async () => {
    const scoped = createScopedApp(makeLmApp(), 'p', null);
    sandboxMocks.fetch.mockClear();
    await scoped.network.fetch('https://example.com/api', {
      headers: { authorization: 'Bearer token' },
    });
    expect(sandboxMocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('未授 network 权限 → PermissionError 先于输入校验(权限门控不变)', async () => {
    const store = new InMemoryPermissionStore();
    await store.deny('p', ['network']);
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(scoped.network.fetch('https://x/')).rejects.toBeInstanceOf(
      PermissionError,
    );
  });

  it('headers 预检边遍历边校验,不物化 entries 中间数组', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../plugins/scoped-app.ts'),
      'utf8',
    );
    expect(source).not.toContain('entries.push(');
  });
});

describe('permission.check / granted', () => {
  it('授权决策查找单趟扫描,不调用 decisions.some', () => {
    const decisions = [
      { permission: 'fs', granted: false, decidedAt: 1 },
      { permission: 'network', granted: true, decidedAt: 2 },
    ] as const;
    const someSpy = vi.spyOn(decisions, 'some');

    try {
      expect(hasGrantedPermissionDecision(decisions, 'network')).toBe(true);
      expect(hasGrantedPermissionDecision(decisions, 'fs')).toBe(false);
      expect(hasGrantedPermissionDecision(decisions, 'shell')).toBe(false);
      expect(someSpy).not.toHaveBeenCalled();
    } finally {
      someSpy.mockRestore();
    }
  });

  it('store 为 null → check 一律 true,granted 返 []', async () => {
    const scoped = createScopedApp(makeLmApp(), 'p', null);
    expect(await scoped.permission.check('fs')).toBe(true);
    expect(await scoped.permission.check('network')).toBe(true);
    const granted = await scoped.permission.granted();
    expect(granted).toEqual([]);
    await expect(scoped.permission.granted()).resolves.toBe(granted);
  });

  it('store 非 null → 反映该 pluginId 的 granted=true 决策', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p.a', ['fs']);
    await store.deny('p.a', ['network']);
    const scoped = createScopedApp(makeLmApp(), 'p.a', store);
    expect(await scoped.permission.check('fs')).toBe(true);
    expect(await scoped.permission.check('network')).toBe(false);
    expect(await scoped.permission.check('clipboard')).toBe(false);
    const g = await scoped.permission.granted();
    expect(g).toEqual(['fs']);
    expect(scoped.permission.granted.toString()).not.toContain('out.push(');
  });

  it('per-plugin 隔离:p.a 的授权不被 p.b 看到', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p.a', ['fs']);
    const coApp = makeLmApp();
    const a = createScopedApp(coApp, 'p.a', store);
    const b = createScopedApp(coApp, 'p.b', store);
    expect(await a.permission.check('fs')).toBe(true);
    expect(await b.permission.check('fs')).toBe(false);
  });
});

describe('fs / clipboard 默认实现(store=null 跳过 gating)', () => {
  it('store=null + 未绑定 plugin-fs token → 抛 no token bound', async () => {
    const scoped = createScopedApp(makeLmApp(), 'p', null);
    await expect(scoped.fs.readFile('/x')).rejects.toThrow(/no token bound/);
    await expect(scoped.fs.writeFile('/x', '')).rejects.toThrow(
      /no token bound/,
    );
    await expect(scoped.fs.listDir('/x')).rejects.toThrow(/no token bound/);
  });
});

describe('Phase 3 runtime gating', () => {
  it('store 非 null 且未授 fs → fs.readFile 抛 PermissionError(不到达 window.api)', async () => {
    const store = new InMemoryPermissionStore();
    // 不 grant 任何
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(scoped.fs.readFile('/x')).rejects.toBeInstanceOf(
      PermissionError,
    );
    await expect(scoped.fs.writeFile('/x', '')).rejects.toBeInstanceOf(
      PermissionError,
    );
    await expect(scoped.fs.listDir('/x')).rejects.toBeInstanceOf(
      PermissionError,
    );
  });

  it('已 deny fs → fs.* 抛 PermissionError', async () => {
    const store = new InMemoryPermissionStore();
    await store.deny('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    const err = await scoped.fs.readFile('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionError);
    if (err instanceof PermissionError) {
      expect(err.permission).toBe('fs');
      expect(err.code).toBe('PERMISSION_DENIED');
    }
  });

  it('已 grant fs 但未绑定 token → 抛 no token bound(过 gating)', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(scoped.fs.readFile('/x')).rejects.toThrow(/no token bound/);
  });

  it('未授 network → fetch 抛 PermissionError(不调 globalThis.fetch)', async () => {
    const store = new InMemoryPermissionStore();
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    const err = await scoped.network
      .fetch('https://example.com')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionError);
    if (err instanceof PermissionError) {
      expect(err.permission).toBe('network');
    }
  });

  it('未授 clipboard → readText/writeText 抛 PermissionError', async () => {
    const store = new InMemoryPermissionStore();
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(scoped.clipboard.readText()).rejects.toBeInstanceOf(
      PermissionError,
    );
    await expect(scoped.clipboard.writeText('x')).rejects.toBeInstanceOf(
      PermissionError,
    );
  });

  // 边界(E181,fs/shell/notifications 兄弟入口同款):clipboard.writeText 授权后、发原生 clipboard 前
  // 校验类型 + UTF-8 字节上限(16MiB)。非 string / 超大 → BAD_INPUT,不调原生 clipboard。
  it('E181 已授 clipboard 但 writeText 非 string / 超大 → 抛 BAD_INPUT', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['clipboard']);
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    const errNonStr = await scoped.clipboard
      .writeText(42 as unknown as string)
      .catch((e: unknown) => e as { code?: string });
    expect(errNonStr.code).toBe('BAD_INPUT');
    const huge = 'x'.repeat(16 * 1024 * 1024 + 1);
    const errBig = await scoped.clipboard
      .writeText(huge)
      .catch((e: unknown) => e as { code?: string });
    expect(errBig.code).toBe('BAD_INPUT');
  });

  it('未授 shell → exec 抛 PermissionError(不到 IPC)', async () => {
    const store = new InMemoryPermissionStore();
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    const err = await scoped.shell
      .exec('echo', ['hi'])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionError);
    if (err instanceof PermissionError) {
      expect(err.permission).toBe('shell');
    }
  });

  it('per-plugin 隔离:p.a 授了 fs,p.b 没授 → p.b 仍抛 PermissionError', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p.a', ['fs']);
    const coApp = makeLmApp();
    const a = createScopedApp(coApp, 'p.a', store);
    const b = createScopedApp(coApp, 'p.b', store);
    await expect(a.fs.readFile('/x')).rejects.toThrow(/no token bound/); // 过 gating
    await expect(b.fs.readFile('/x')).rejects.toBeInstanceOf(PermissionError);
  });
});

describe('授后转发 — fs / shell / clipboard / mcp / network 行为', () => {
  beforeEachClear();
  afterEachClear();

  it('fs.readFile → 返 pluginFsRaw 结果', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    coApiMocks.pluginFsRaw.readFile.mockResolvedValueOnce('hello');
    const scoped = createScopedApp(makeLmApp(), 'p', store, 'test-token');
    expect(await scoped.fs.readFile('/x')).toBe('hello');
    expect(coApiMocks.pluginFsRaw.readFile).toHaveBeenCalledWith(
      'test-token',
      '/x',
    );
  });

  it('fs.readFile/writeFile/listDir reject → 透传 raw API error', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    coApiMocks.pluginFsRaw.readFile.mockRejectedValueOnce(
      new Error('ScopeError: denied'),
    );
    coApiMocks.pluginFsRaw.writeFile.mockRejectedValueOnce(new Error('EROFS: ro'));
    coApiMocks.pluginFsRaw.listDir.mockRejectedValueOnce(
      new Error('EACCES: denied'),
    );
    const scoped = createScopedApp(makeLmApp(), 'p', store, 'test-token');
    await expect(scoped.fs.readFile('/x')).rejects.toThrow(
      /ScopeError.*denied/,
    );
    await expect(scoped.fs.writeFile('/x', '')).rejects.toThrow(/EROFS.*ro/);
    await expect(scoped.fs.listDir('/x')).rejects.toThrow(/EACCES.*denied/);
  });

  it('fs.writeFile/listDir 透传 pluginFsRaw', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    coApiMocks.pluginFsRaw.listDir.mockResolvedValueOnce([
      { name: 'a', isFile: true, isDirectory: false, isSymlink: false },
    ]);
    const scoped = createScopedApp(makeLmApp(), 'p', store, 'test-token');
    await scoped.fs.writeFile('/x', 'data');
    const list = await scoped.fs.listDir('/x');
    expect(list[0]?.name).toBe('a');
    expect(coApiMocks.pluginFsRaw.writeFile).toHaveBeenCalledWith(
      'test-token',
      '/x',
      'data',
    );
    expect(coApiMocks.pluginFsRaw.listDir).toHaveBeenCalledWith(
      'test-token',
      '/x',
    );
  });

  it('fs.listDir 条目转换单趟扫描,不调用 entries.map', () => {
    const entries = [
      { name: 'a.txt', isDirectory: false, isSymlink: false },
      { name: 'dir', isDirectory: true, isSymlink: true },
    ];
    const mapSpy = vi.spyOn(entries, 'map');

    try {
      expect(buildPluginListDirEntries('/repo/', entries)).toEqual([
        {
          path: '/repo/a.txt',
          name: 'a.txt',
          isDirectory: false,
          isSymlink: false,
        },
        {
          path: '/repo/dir',
          name: 'dir',
          isDirectory: true,
          isSymlink: true,
        },
      ]);
      expect(mapSpy).not.toHaveBeenCalled();
      expect(buildPluginListDirEntries.toString()).not.toContain('out.push(');
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('fs.listDir 空条目转换复用稳定空列表', () => {
    expect(buildPluginListDirEntries('/repo', [])).toEqual([]);
    expect(buildPluginListDirEntries('/repo', [])).toBe(
      buildPluginListDirEntries('/other', []),
    );
  });

  // 边界(E44,E29 renderer 侧对偶 / E41-E43 同族):scoped fs.writeFile 发 IPC 前预检 content/path
  // 大小,超限直接抛、不调 pluginFsRaw.writeFile(挡 ipcRenderer structured-clone 前置放大)。
  it('E44 content 超 MAX_WRITE_BYTES → 抛且不发 IPC', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store, 'test-token');
    const huge = 'x'.repeat(MAX_WRITE_BYTES + 1);
    await expect(scoped.fs.writeFile('/x', huge)).rejects.toThrow(
      /content too large/i,
    );
    expect(coApiMocks.pluginFsRaw.writeFile).not.toHaveBeenCalled();
  });

  // 边界(E312,E269 反模式复现):content 契约是 string —— `typeof === 'string' && 字节检查` 对非 string
  // 短路跳过检查,非 string(JS 插件绕 TS 类型传对象/Uint8Array)会直接经 structured-clone 进 IPC。改
  // `!== 'string'` 即拒,非 string 不发 IPC。
  it('E312 非 string content(JS 插件绕类型)→ 抛且不发 IPC', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store, 'test-token');
    await expect(
      scoped.fs.writeFile('/x', { evil: 1 } as unknown as string),
    ).rejects.toThrow(/must be a string/i);
    // neutralize 敏感:旧 `typeof === 'string' &&` 对非 string 短路 → 不抛 → 转发 raw API。
    expect(coApiMocks.pluginFsRaw.writeFile).not.toHaveBeenCalled();
  });

  it('E44 path 超 FS_PATH_MAX → 抛且不发 IPC', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store, 'test-token');
    const longPath = '/' + 'x'.repeat(FS_PATH_MAX);
    await expect(scoped.fs.writeFile(longPath, 'data')).rejects.toThrow(
      /too long/i,
    );
    expect(coApiMocks.pluginFsRaw.writeFile).not.toHaveBeenCalled();
  });

  // 边界(E180,E178 renderer 对偶):app.fs 所有路径方法发 IPC 前预检路径长度/type(assertPluginFsPath
  // 复用 FS_PATH_MAX),挡超长路径 structured-clone 进 preload/main 的前置放大 + 非 string TypeError。
  it('E180 readFile/listDir/stat/.../rename/cp/atomicReplace 超长路径 → 抛且不发 IPC', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store, 'test-token');
    const longPath = '/' + 'x'.repeat(FS_PATH_MAX + 1);
    const raw = coApiMocks.pluginFsRaw;
    await expect(scoped.fs.readFile(longPath)).rejects.toThrow(/too long/i);
    await expect(scoped.fs.listDir(longPath)).rejects.toThrow(/too long/i);
    await expect(scoped.fs.stat(longPath)).rejects.toThrow(/too long/i);
    await expect(scoped.fs.lstat(longPath)).rejects.toThrow(/too long/i);
    await expect(scoped.fs.realpath(longPath)).rejects.toThrow(/too long/i);
    await expect(scoped.fs.mkdir(longPath)).rejects.toThrow(/too long/i);
    await expect(scoped.fs.rm(longPath)).rejects.toThrow(/too long/i);
    await expect(scoped.fs.rename(longPath, '/ok')).rejects.toThrow(/too long/i);
    await expect(scoped.fs.rename('/ok', longPath)).rejects.toThrow(/too long/i);
    await expect(scoped.fs.cp(longPath, '/ok')).rejects.toThrow(/too long/i);
    await expect(scoped.fs.cp('/ok', longPath)).rejects.toThrow(/too long/i);
    await expect(scoped.fs.readGitBlob(longPath, 'abc')).rejects.toThrow(
      /too long/i,
    );
    await expect(
      scoped.fs.atomicReplaceWithinScope(longPath, '/ok'),
    ).rejects.toThrow(/too long/i);
    // 任何一个超长路径方法都不应发 IPC
    for (const m of [
      'readFile',
      'listDir',
      'stat',
      'lstat',
      'realpath',
      'mkdir',
      'rm',
      'rename',
      'cp',
      'readGitBlob',
      'atomicReplaceWithinScope',
    ] as const) {
      expect(raw[m]).not.toHaveBeenCalled();
    }
  });

  // 边界(E314,E63 renderer 对偶 / pre-IPC):readGitBlob 发 IPC 前校验 sha hex 形态(4-64 hex),
  // 非 hex/超长 → BAD_INPUT 不发 IPC(单一来源 isValidGitBlobSha)。
  it('E314 readGitBlob 非法 sha(非 hex / 超长)→ BAD_INPUT 且不发 IPC', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store, 'test-token');
    await expect(
      scoped.fs.readGitBlob('/repo', 'not-hex-zz'),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(
      scoped.fs.readGitBlob('/repo', 'a'.repeat(65)),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    // neutralize 敏感:去 sha 预检则转发 raw API。
    expect(coApiMocks.pluginFsRaw.readGitBlob).not.toHaveBeenCalled();
  });

  it('E314 合法 sha(4-64 hex)→ 透传(回归)', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store, 'test-token');
    await scoped.fs.readGitBlob('/repo', 'abcd1234');
    expect(coApiMocks.pluginFsRaw.readGitBlob).toHaveBeenCalled();
  });

  // 边界(E315,E313 同族 / 不转发 raw 外部对象):mkdir/rm/cp/atomicReplace 的 opts 只转发契约 boolean
  // 字段,丢弃 JS 插件绕类型塞的额外字段,不让整 opts 进 IPC。
  it('E315 fs opts 只转发契约 boolean 字段(丢弃额外/强制 boolean)', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store, 'test-token');
    await scoped.fs.mkdir('/d', {
      recursive: true,
      evil: 'x'.repeat(100),
    } as unknown as { recursive?: boolean });
    // neutralize 敏感:旧码传整 opts → call[2] 含 evil。
    expect(coApiMocks.pluginFsRaw.mkdir.mock.calls[0]?.[2]).toEqual({
      recursive: true,
    });
    await scoped.fs.rm('/d', {
      recursive: true,
      force: true,
      junk: 9,
    } as unknown as { recursive?: boolean; force?: boolean });
    expect(coApiMocks.pluginFsRaw.rm.mock.calls[0]?.[2]).toEqual({
      recursive: true,
      force: true,
    });
    await scoped.fs.cp('/s', '/d2', {
      recursive: true,
      extra: 'z',
    } as unknown as { recursive?: boolean });
    expect(coApiMocks.pluginFsRaw.cp.mock.calls[0]?.[3]).toEqual({
      recursive: true,
    });
    await scoped.fs.atomicReplaceWithinScope('/s', '/f', {
      overwrite: true,
      bad: {},
    } as unknown as { overwrite?: boolean });
    expect(
      coApiMocks.pluginFsRaw.atomicReplaceWithinScope.mock.calls[0]?.[3],
    ).toEqual({ overwrite: true });
  });

  it('E180 上限内路径正常透传(回归)', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store, 'test-token');
    await scoped.fs.readFile('/ok/file.txt');
    expect(coApiMocks.pluginFsRaw.readFile).toHaveBeenCalledWith(
      'test-token',
      '/ok/file.txt',
    );
  });

  it('E44 上限内正常 writeFile → 正常透传', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store, 'test-token');
    await scoped.fs.writeFile('/x', 'ok');
    expect(coApiMocks.pluginFsRaw.writeFile).toHaveBeenCalledWith(
      'test-token',
      '/x',
      'ok',
    );
  });

  it('shell.exec 授后透传 + ok=true 返 data', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['shell']);
    coApiMocks.shellExec.mockResolvedValueOnce({
      ok: true,
      data: { stdout: 'hi', stderr: '', exitCode: 0 },
    });
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    const r = await scoped.shell.exec('echo', ['hi']);
    expect(r.stdout).toBe('hi');
  });

  it('shell.exec ok=false → 抛带 code:message', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['shell']);
    coApiMocks.shellExec.mockResolvedValueOnce({
      ok: false,
      code: 'EBUSY',
      message: 'pty busy',
    });
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(scoped.shell.exec('echo', [])).rejects.toThrow(
      /EBUSY.*pty busy/,
    );
  });

  // i18n(I13):exec 失败抛的 Error 须保留 r.code,否则冒泡到 runContributedAction 拿不到
  // code、无法按 catalog 本地化 → zh/ko toast 显英文 raw。
  it('shell.exec ok=false → 抛的 Error 保留 code(供 by-code 本地化)', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['shell']);
    coApiMocks.shellExec.mockResolvedValueOnce({
      ok: false,
      code: 'BAD_INPUT',
      message: 'invalid args',
    });
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(scoped.shell.exec('echo', [])).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
  });

  // 边界(E46,E44/E45 同族):shell.exec/execStream 在 renderer wrapper 里 spread/发 IPC 前预检
  // cmd/args/cwd/env/input,超限抛 BAD_INPUT、不 [...args]、不发 IPC。
  it('E46 shell.exec args 数量超 1024 → 抛 BAD_INPUT,不发 IPC', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['shell']);
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    const manyArgs = Array.from({ length: 1025 }, () => 'a');
    await expect(scoped.shell.exec('echo', manyArgs)).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
    expect(coApiMocks.shellExec).not.toHaveBeenCalled();
  });

  it('shell.exec args 复制不通过 spread,空 args 复用稳定空数组', async () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../plugins/scoped-app.ts'),
      'utf-8',
    );
    expect(src).toContain('copyShellArgs');
    expect(src).not.toContain('args: [...args]');

    const store = new InMemoryPermissionStore();
    await store.grant('p', ['shell']);
    coApiMocks.shellExec.mockResolvedValue({
      ok: true,
      data: { stdout: '', stderr: '', exitCode: 0 },
    });
    const scoped = createScopedApp(makeLmApp(), 'p', store);

    await scoped.shell.exec('echo', []);
    await scoped.shell.exec('echo', []);
    expect(coApiMocks.shellExec.mock.calls[1]![0].args).toBe(
      coApiMocks.shellExec.mock.calls[0]![0].args,
    );

    const args = ['hi'];
    await scoped.shell.exec('echo', args);
    args[0] = 'changed';
    expect(coApiMocks.shellExec.mock.calls[2]![0].args).toEqual(['hi']);
  });

  it('E46 shell args 单项校验单趟扫描,不调用 args.every', () => {
    const args = ['ok', 'x'.repeat(16_385)];
    const everySpy = vi.spyOn(args, 'every');

    try {
      expect(areValidShellArgs(args)).toBe(false);
      expect(areValidShellArgs(['ok', 'still-ok'])).toBe(true);
      expect(everySpy).not.toHaveBeenCalled();
    } finally {
      everySpy.mockRestore();
    }
  });

  it('E46 shell.exec 单 arg 超 16384 / 超长 input·cmd → 抛 BAD_INPUT', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['shell']);
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(
      scoped.shell.exec('echo', ['x'.repeat(16385)]),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(
      scoped.shell.exec('echo', [], { input: 'x'.repeat(1_000_001) }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(
      scoped.shell.exec('x'.repeat(8193), []),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(coApiMocks.shellExec).not.toHaveBeenCalled();
  });

  // 边界(E129,E125 同族):scoped shell.exec 的 stdin 预检按真实 UTF-8 字节。CJK 334k 字 = 1.002MB
  // 字节但 length 334k ≤ 1MB,旧 .length 会误放行(发 IPC)。
  it('E129 shell.exec input 多字节真实字节超 1MB → 抛 BAD_INPUT 且不发 IPC', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['shell']);
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(
      scoped.shell.exec('echo', [], { input: '中'.repeat(334_000) }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(coApiMocks.shellExec).not.toHaveBeenCalled();
  });

  it('E46 shell.exec 非数组 args(避免无限 spread)→ 抛 BAD_INPUT', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['shell']);
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    // 模拟畸形插件传入非数组(运行时绕过类型)。
    await expect(
      scoped.shell.exec('echo', 'not-an-array' as never),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(coApiMocks.shellExec).not.toHaveBeenCalled();
  });

  // 边界(E198,E197 同族有界迭代):env 校验用 for...in 单次遍历,边计数边校验,超
  // SHELL_ENV_MAX_ENTRIES 立即 bad() —— 不先 Object.keys 把插件传入的 env 所有 key 全量物化。
  it('E198 shell.exec env 条目数超上限 → BAD_INPUT 且不 Object.keys 全量物化,不发 IPC', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['shell']);
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    const bigEnv: Record<string, string> = {};
    for (let i = 0; i <= 1024; i++) bigEnv[`K${i}`] = 'v'; // 1025 > SHELL_ENV_MAX_ENTRIES(1024)
    // spy 立即捕获:在 await 后、任何匹配器(rejects/toMatchObject 自身会调 Object.keys)前读计数。
    const keysSpy = vi.spyOn(Object, 'keys');
    let err: unknown;
    try {
      await scoped.shell.exec('echo', [], { env: bigEnv });
    } catch (e) {
      err = e;
    }
    const keysCalledDuringExec = keysSpy.mock.calls.length;
    keysSpy.mockRestore();
    expect(err).toMatchObject({ code: 'BAD_INPUT' });
    expect(keysCalledDuringExec).toBe(0); // for...in 单次遍历,exec 路径不调 Object.keys 物化 env
    expect(coApiMocks.shellExec).not.toHaveBeenCalled();
  });

  // 边界(E313,E46/E312 同族 / 不转发 raw 外部对象):execStream 只转发契约字段 {timeoutMs, cwd},
  // 丢弃 JS 插件绕类型塞的额外字段,不让整 opts 进 IPC structured-clone。
  it('E313 execStream opts 只转发 {cwd,timeoutMs},丢弃额外字段', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['shell']);
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    const optsWithExtras = {
      cwd: '/w',
      timeoutMs: 5000,
      evil: 'x'.repeat(100),
      env: { A: 'b' },
    } as unknown as { timeoutMs?: number; cwd?: string };
    const r = scoped.shell.execStream('echo', ['hi'], optsWithExtras);
    await r.done; // 触发 start() → validateShellInput + raw execStream
    expect(coApiMocks.pluginShellStreamRaw.execStream).toHaveBeenCalledTimes(1);
    const passedOpts =
      coApiMocks.pluginShellStreamRaw.execStream.mock.calls[0]?.[2];
    // neutralize 敏感:旧码传整 opts → passedOpts 含 evil/env。
    expect(passedOpts).toEqual({ cwd: '/w', timeoutMs: 5000 });
  });

  it('E198 上限内 env(超长 key / 非字符串 value)仍正确校验(回归)', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['shell']);
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(
      scoped.shell.exec('echo', [], { env: { ['K'.repeat(1025)]: 'v' } }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' }); // 超长 key
    await expect(
      scoped.shell.exec('echo', [], { env: { K: 123 as never } }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' }); // 非字符串 value
    expect(coApiMocks.shellExec).not.toHaveBeenCalled();
  });

  it('E46 上限内正常 shell.exec → 正常透传', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['shell']);
    coApiMocks.shellExec.mockResolvedValueOnce({
      ok: true,
      data: { stdout: 'ok', stderr: '', exitCode: 0 },
    });
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await scoped.shell.exec('echo', ['hi'], { input: 'x' });
    expect(coApiMocks.shellExec).toHaveBeenCalled();
  });

  it('mcp.register 授后调 registry.register(spec, pluginId)', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['mcp-tools']);
    const coApp = makeLmApp();
    const regSpy = vi.spyOn(coApp.mcp, 'register');
    const scoped = createScopedApp(coApp, 'p', store);
    // E53:register 现做输入预检,stub spec 须完整(jsonSchema 可序列化 + inputSchema 有 safeParse)。
    const spec = {
      name: 'tool.x',
      description: 'desc',
      jsonSchema: { type: 'object' },
      inputSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
      run: async () => ({}),
    };
    await scoped.mcp.register(spec as never);
    expect(regSpy).toHaveBeenCalledWith(spec, 'p');
  });

  it('未授 mcp-tools → register 抛 PermissionError', async () => {
    const store = new InMemoryPermissionStore();
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    await expect(
      scoped.mcp.register({ name: 'x', run: async () => ({}) } as never),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it('permission.granted 列出已授项,deny 不计入', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    await store.deny('p', ['network']);
    const scoped = createScopedApp(makeLmApp(), 'p', store);
    const granted = await scoped.permission.granted();
    expect(granted).toEqual(['fs']);
    expect(scoped.permission.granted.toString()).not.toContain('out.push(');
  });
});

describe('PermissionError', () => {
  it('code = PERMISSION_DENIED,permission 字段暴露', () => {
    const err = new PermissionError('fs');
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.permission).toBe('fs');
    // i18n(I11):默认 message 改英文(避免经 toast 泄漏中文到 en/ko 界面)
    expect(err.message).toBe('Permission denied: fs');
    expect(err.name).toBe('PermissionError');
    expect(err).toBeInstanceOf(Error);
  });

  it('自定义 message 覆盖默认', () => {
    const err = new PermissionError('network', 'fetch needs network');
    expect(err.message).toBe('fetch needs network');
    expect(err.permission).toBe('network');
  });
});

// 边界(E239,E44/E180 pre-IPC 预检族):fs.requestScope 发 IPC 前用共享 helper 校验 scopes,超量/畸形
// 直接 reject(BAD_INPUT),不让超大数组/超长路径进 renderer→preload→main 的 structured clone(IPC 放大)。
describe('E239 fs.requestScope pre-IPC scopes 校验', () => {
  beforeEachClear();
  afterEachClear();

  it('合法 scopes → 转发 pluginFsRaw.requestScope', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store, 'test-token');
    const r = await scoped.fs.requestScope([{ path: '/work', mode: 'rw' }]);
    expect(r).toBe('grant');
    expect(coApiMocks.pluginFsRaw.requestScope).toHaveBeenCalledWith('test-token', [
      { path: '/work', mode: 'rw' },
    ]);
  });

  it('数量超 MAX_SCOPE_REQUEST_COUNT(64)→ 抛 BAD_INPUT,不调 IPC', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store, 'test-token');
    const tooMany = Array.from({ length: MAX_SCOPE_REQUEST_COUNT + 1 }, () => ({
      path: '/x',
      mode: 'r' as const,
    }));
    await expect(scoped.fs.requestScope(tooMany)).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
    expect(coApiMocks.pluginFsRaw.requestScope).not.toHaveBeenCalled();
  });

  it('单项 path 超 FS_PATH_MAX 或 mode 非法 → 抛 BAD_INPUT,不调 IPC', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('p', ['fs']);
    const scoped = createScopedApp(makeLmApp(), 'p', store, 'test-token');
    await expect(
      scoped.fs.requestScope([{ path: 'x'.repeat(FS_PATH_MAX + 1), mode: 'r' }]),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(
      // @ts-expect-error 故意传非法 mode 验证运行时守卫
      scoped.fs.requestScope([{ path: '/ok', mode: 'x' }]),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(coApiMocks.pluginFsRaw.requestScope).not.toHaveBeenCalled();
  });
});
