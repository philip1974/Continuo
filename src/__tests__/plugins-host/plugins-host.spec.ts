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
  it('listPluginDirs 不为未使用的插件生成 Blob URL;只读到的那个才生成(一次)', () => {
    const infos = buildPluginDirInfos([
      { id: 'a', manifestText: '{}', mainText: 'export default 1' },
      { id: 'b', manifestText: '{}', mainText: 'export default 2' },
      { id: 'c', manifestText: '{}', mainText: 'export default 3' },
    ]);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(infos[1]!.moduleUrl).toBe('blob:mock-url');
    expect(infos[1]!.moduleUrl).toBe('blob:mock-url');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
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
        mainText: 'export default {}',
      },
    ];
    const mapSpy = vi.spyOn(dirs, 'map');

    try {
      expect(buildPluginDirInfos(dirs)).toEqual([
        {
          id: 'p1',
          manifestText: '{"id":"p1"}',
          moduleUrl: 'blob:mock-url',
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

  it('ok=true → 把 mainText 转 Blob URL,其它字段透传', async () => {
    installFakeApi({
      listDirs: vi.fn().mockResolvedValue({
        ok: true,
        data: [
          {
            id: 'p1',
            manifestText: '{"id":"p1"}',
            mainText: 'export default {}',
          },
        ],
      }),
    });

    const host = createWindowApiHost();
    const dirs = await host.listPluginDirs();

    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatchObject({
      id: 'p1',
      manifestText: '{"id":"p1"}',
      moduleUrl: 'blob:mock-url',
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
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

// perf:热重载按 id 只读单个插件目录(coApi.plugins.readDirById)。
describe('createWindowApiHost.readPluginDirByManifestId', () => {
  it('ok=true → 透传 id/manifestText,mainText 惰性转 Blob URL', async () => {
    const readDirById = vi.fn().mockResolvedValue({
      ok: true,
      data: { id: 'dir', manifestText: '{"id":"p1"}', mainText: 'export default {}' },
    });
    installFakeApi({ readDirById } as Partial<FakePluginsApi>);
    const host = createWindowApiHost();
    const info = await host.readPluginDirByManifestId!('p1');
    expect(readDirById).toHaveBeenCalledWith('p1');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(info).toMatchObject({ id: 'dir', manifestText: '{"id":"p1"}', moduleUrl: 'blob:mock-url' });
  });

  it('data=null → null;ok=false → warn + null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const readDirById = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockResolvedValueOnce({ ok: false, code: 'EIO', message: 'disk' });
    installFakeApi({ readDirById } as Partial<FakePluginsApi>);
    const host = createWindowApiHost();
    await expect(host.readPluginDirByManifestId!('p1')).resolves.toBeNull();
    await expect(host.readPluginDirByManifestId!('p1')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('readDirById failed'), 'EIO', 'disk');
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

  // 数据安全(codex 复查 P1):读失败必须**传播**而非降级空 Set —— 否则 mutateEnabledIds
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

  // 数据安全(codex 复查 P2):持久化失败必须传播而非静默 warn —— 否则 enable/disable
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
