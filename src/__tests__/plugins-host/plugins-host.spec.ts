// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import {
  buildPluginDirInfos,
  createWindowApiHost,
} from '../../lib/plugins-host';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listPluginDirs,
  readPluginMainByDir,
} from '../../../electron/main/services/plugins.service';

interface FakePluginsApi {
  listDirs: ReturnType<typeof vi.fn>;
  readEnabled: ReturnType<typeof vi.fn>;
  mutateEnabled: ReturnType<typeof vi.fn>;
  uninstall: ReturnType<typeof vi.fn>;
}

function installFakeApi(plugins: Partial<FakePluginsApi>): void {
  const api = { plugins };
  Object.defineProperty(window, 'api', {
    value: api,
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

let createObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetLmApiForTest();
  // jsdom 没有 URL.createObjectURL,补一个 mock
  createObjectURL = vi.fn(() => 'blob:mock-url');
  Object.defineProperty(URL, 'createObjectURL', {
    value: createObjectURL,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  vi.restoreAllMocks();
});

// Blob URL 泄漏:每次 listPluginDirs(init / 每次 reload)此前为**所有**插件 createObjectURL 且从不
// revoke → 反复 reload 单调泄漏。契约:URL 仅在真正读取 moduleUrl(激活该插件时)才生成;
// import 完成(成功或失败)后 revoke —— 已求值模块留在 module map,同 URL 再 import 命中缓存,不依赖 blob 存活。
describe('Blob URL 生命周期', () => {
  it('listPluginDirs 构造与读取 moduleUrl 都不生成 Blob URL(激活 import 时才生成);moduleUrl 稳定', () => {
    const infos = buildPluginDirInfos([
      { id: 'a', manifestText: '{}', manifestHash: '0'.repeat(64) },
      { id: 'b', manifestText: '{}', manifestHash: '0'.repeat(64) },
      { id: 'c', manifestText: '{}', manifestHash: '0'.repeat(64) },
    ]);
    expect(infos[1]!.moduleUrl).toBe(infos[1]!.moduleUrl);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('importModule 结束后 revoke 该 blob URL(失败也 revoke);非 blob URL 不 revoke', async () => {
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURL,
      writable: true,
      configurable: true,
    });
    const host = createWindowApiHost();
    await expect(host.importModule('blob:nonexistent-plugin')).rejects.toBeDefined();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:nonexistent-plugin');

    revokeObjectURL.mockClear();
    await expect(host.importModule('/nonexistent-plugin.js')).rejects.toBeDefined();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});

describe('createWindowApiHost.listPluginDirs', () => {
  it('PluginDirInfo 构造单趟扫描,不调用 dirs.map', () => {
    const dirs = [
      {
        id: 'p1',
        manifestText: '{"id":"p1"}',
        manifestHash: 'a'.repeat(64),
      },
    ];
    const mapSpy = vi.spyOn(dirs, 'map');

    try {
      expect(buildPluginDirInfos(dirs)).toEqual([
        {
          id: 'p1',
          manifestText: '{"id":"p1"}',
          moduleUrl: expect.any(String),
        },
      ]);
      expect(mapSpy).not.toHaveBeenCalled();
      expect(buildPluginDirInfos.toString()).not.toContain('out.push(');
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('空 PluginDirInfo 输入复用稳定空列表', () => {
    expect(buildPluginDirInfos([])).toEqual([]);
    expect(buildPluginDirInfos([])).toBe(buildPluginDirInfos([]));
  });

  // perf:listDirs 只带 manifest(不带 main 源码);moduleUrl 是惰性引用,importModule 时才按目录名拉源码。
  it('ok=true → id/manifestText 透传;读 moduleUrl 不拉源码、不生成 Blob URL', async () => {
    const readMainByDir = vi.fn();
    installFakeApi({
      listDirs: vi.fn().mockResolvedValue({
        ok: true,
        data: [{ id: 'p1', manifestText: '{"id":"p1"}', manifestHash: 'a'.repeat(64) }],
      }),
      readMainByDir,
    } as Partial<FakePluginsApi>);

    const host = createWindowApiHost();
    const dirs = await host.listPluginDirs();

    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatchObject({ id: 'p1', manifestText: '{"id":"p1"}' });
    expect(typeof dirs[0]!.moduleUrl).toBe('string');
    expect(dirs[0]!.moduleUrl).toBe(dirs[0]!.moduleUrl);
    expect(readMainByDir).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('ok=false → console.warn + 返 []', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installFakeApi({
      listDirs: vi
        .fn()
        .mockResolvedValue({ ok: false, code: 'EIO', message: 'disk' }),
    });
    const host = createWindowApiHost();

    const dirs = await host.listPluginDirs();
    expect(dirs).toEqual([]);
    await expect(host.listPluginDirs()).resolves.toBe(dirs);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('listDirs failed'),
      'EIO',
      'disk',
    );
  });
});

// perf:启动列举不再为每个候选(含未启用)读 main 源码并经 IPC 传给每个窗口;激活时按**目录名**拉取。
describe('createWindowApiHost:main 源码激活时按目录拉取', () => {
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: revokeObjectURL,
      writable: true,
      configurable: true,
    });
  });

  async function listed(readMainByDir: ReturnType<typeof vi.fn>) {
    installFakeApi({
      listDirs: vi.fn().mockResolvedValue({
        ok: true,
        data: [
          { id: 'dir.a', manifestText: '{"id":"x"}', manifestHash: 'g'.repeat(64) },
          { id: 'dir.b', manifestText: '{"id":"y"}', manifestHash: 'h'.repeat(64) },
        ],
      }),
      readMainByDir,
    } as Partial<FakePluginsApi>);
    const host = createWindowApiHost();
    return { host, dirs: await host.listPluginDirs() };
  }

  it('importModule(moduleUrl) → 按目录名拉一次源码 → Blob URL → import 后 revoke;同 moduleUrl 再 import 不重拉', async () => {
    const readMainByDir = vi.fn().mockResolvedValue({ ok: true, data: 'export default 1' });
    const { host, dirs } = await listed(readMainByDir);
    // jsdom 无法 import blob: URL → reject;此处只验证拉取 / Blob / revoke 链路。
    await expect(host.importModule(dirs[1]!.moduleUrl)).rejects.toBeDefined();
    expect(readMainByDir).toHaveBeenCalledTimes(1);
    expect(readMainByDir).toHaveBeenCalledWith('dir.b', 'h'.repeat(64));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');

    await expect(host.importModule(dirs[1]!.moduleUrl)).rejects.toBeDefined();
    expect(readMainByDir).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('源码不可读(data=null / ok=false)→ importModule reject,不生成 Blob URL;下次重试会再拉', async () => {
    const readMainByDir = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({ ok: false, code: 'EIO', message: 'disk' });
    const { host, dirs } = await listed(readMainByDir);
    await expect(host.importModule(dirs[0]!.moduleUrl)).rejects.toBeDefined();
    await expect(host.importModule(dirs[0]!.moduleUrl)).rejects.toMatchObject({ code: 'EIO' });
    expect(readMainByDir).toHaveBeenCalledTimes(2);
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('每次列举得到新的 moduleUrl(重新 init 读到最新源码)', async () => {
    const readMainByDir = vi.fn();
    const { host, dirs } = await listed(readMainByDir);
    const again = await host.listPluginDirs();
    expect(again[0]!.moduleUrl).not.toBe(dirs[0]!.moduleUrl);
    expect(dirs[0]!.moduleUrl).not.toBe(dirs[1]!.moduleUrl);
  });
});

// P1(service→host):列举快照与激活时拉取的 main 须出自同一 manifest 版本。真实 listPluginDirs /
// readPluginMainByDir(临时目录)接到 host 上,模拟 safeHandle 把抛错折成 IpcResult。延迟激活期间插件被更新
//(manifest id / 权限 / main 全换)→ importModule 以 PLUGIN_MANIFEST_CHANGED 拒绝,不执行新 main。
describe('createWindowApiHost:列举快照与激活拉取的 main 一致(真实 service)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'lm-plugins-host-'));
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      writable: true,
      configurable: true,
    });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writePlugin(manifest: object, main: string): void {
    mkdirSync(join(tmp, 'p'), { recursive: true });
    writeFileSync(join(tmp, 'p', 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(tmp, 'p', 'main.js'), main);
  }

  function toIpc<T>(p: Promise<T>) {
    return p.then(
      (data) => ({ ok: true as const, data }),
      (e: { code?: string; message?: string }) => ({ ok: false as const, code: e.code, message: e.message }),
    );
  }

  function installRealService(): ReturnType<typeof vi.fn> {
    const readMainByDir = vi.fn((dir: string, manifestHash: string) =>
      toIpc(readPluginMainByDir(tmp, dir, manifestHash)),
    );
    installFakeApi({
      listDirs: vi.fn(() => toIpc(listPluginDirs(tmp))),
      readMainByDir,
    } as Partial<FakePluginsApi>);
    return readMainByDir;
  }

  it('列举后、激活前 manifest + main 被替换 → importModule 以 PLUGIN_MANIFEST_CHANGED 拒绝,不生成 Blob URL', async () => {
    writePlugin({ id: 'a', name: 'A', version: '0.1.0', permissions: [] }, 'OLD');
    const readMainByDir = installRealService();
    const host = createWindowApiHost();
    const [info] = await host.listPluginDirs();
    expect(info!.manifestText).toContain('"id":"a"');

    // 延迟激活(如权限弹窗挂起)期间插件被原子更新成另一插件
    writePlugin({ id: 'b', name: 'B', version: '9.9.9', permissions: ['shell'] }, 'NEW');

    await expect(host.importModule(info!.moduleUrl)).rejects.toMatchObject({
      code: 'PLUGIN_MANIFEST_CHANGED',
    });
    expect(readMainByDir).toHaveBeenCalledWith('p', expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('只换 main(manifest 不变)→ 仍按快照令牌放行(main 变更由 watcher 热重载处理)', async () => {
    writePlugin({ id: 'a', name: 'A', version: '0.1.0' }, 'OLD');
    installRealService();
    const host = createWindowApiHost();
    const [info] = await host.listPluginDirs();
    writePlugin({ id: 'a', name: 'A', version: '0.1.0' }, 'NEW');
    // jsdom 无法 import blob: URL → reject,但源码已拉到并生成 Blob URL(令牌校验通过)
    await expect(host.importModule(info!.moduleUrl)).rejects.toBeDefined();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });
});

describe('createWindowApiHost.readEnabledIds', () => {
  it('ok=true → 转 Set', async () => {
    installFakeApi({
      readEnabled: vi
        .fn()
        .mockResolvedValue({ ok: true, data: ['a', 'b', 'a'] }),
    });
    const host = createWindowApiHost();
    const set = await host.readEnabledIds();
    expect(set).toBeInstanceOf(Set);
    expect(Array.from(set).sort()).toEqual(['a', 'b']);
  });

  // 数据安全(复查 P1):读失败必须**传播**而非降级空 Set —— 否则 mutateEnabledIds
  // 的 RMW 会基于空集合写回,抹掉其它已启用插件。main 端仅 ENOENT 返回 [](ok=true 空),
  // ok=false 只在 EACCES/EIO 等真错误时出现 → host 抛带 code。
  it('ok=false → 抛 Error 带 code(不再降级空 Set)', async () => {
    installFakeApi({
      readEnabled: vi.fn().mockResolvedValue({
        ok: false,
        code: 'EACCES',
        message: 'denied',
      }),
    });
    const host = createWindowApiHost();
    await expect(host.readEnabledIds()).rejects.toMatchObject({
      code: 'EACCES',
    });
  });
});

describe('createWindowApiHost.mutateEnabledId', () => {
  it('ok=true → 把 (id, enabled) delta 透传给 IPC,不抛', async () => {
    const mutateEnabled = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({ mutateEnabled });

    const host = createWindowApiHost();
    await host.mutateEnabledId('x', true);
    expect(mutateEnabled).toHaveBeenCalledWith('x', true);
  });

  // 数据安全(复查 P2):持久化失败必须传播而非静默 warn —— 否则 enable/disable
  // 静默 resolve,用户以为已切换但盘未写,重启回滚/禁用插件复活。
  it('ok=false → 抛 Error 带 code(不再静默 warn)', async () => {
    installFakeApi({
      mutateEnabled: vi.fn().mockResolvedValue({
        ok: false,
        code: 'EACCES',
        message: 'denied',
      }),
    });

    const host = createWindowApiHost();
    await expect(host.mutateEnabledId('a', false)).rejects.toMatchObject({
      code: 'EACCES',
    });
  });
});

describe('createWindowApiHost.removePluginDir', () => {
  it('ok=true → resolve', async () => {
    installFakeApi({
      uninstall: vi.fn().mockResolvedValue({ ok: true }),
    });
    const host = createWindowApiHost();
    expect(host.removePluginDir).toBeDefined();
    await expect(host.removePluginDir!('p1')).resolves.toBeUndefined();
  });

  it('ok=false → 抛 Error 带 code', async () => {
    installFakeApi({
      uninstall: vi.fn().mockResolvedValue({
        ok: false,
        code: 'EBUSY',
        message: 'in use',
      }),
    });
    const host = createWindowApiHost();
    try {
      await host.removePluginDir!('p1');
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as Error).message).toBe('in use');
      expect((err as { code?: string }).code).toBe('EBUSY');
    }
  });
});
