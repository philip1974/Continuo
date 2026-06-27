// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { createWindowApiHost } from '../../lib/plugins-host';

interface FakePluginsApi {
  listDirs: ReturnType<typeof vi.fn>;
  readEnabled: ReturnType<typeof vi.fn>;
  writeEnabled: ReturnType<typeof vi.fn>;
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

describe('createWindowApiHost.listPluginDirs', () => {
  it('ok=true → 把 mainText 转 Blob URL,其它字段透传', async () => {
    installFakeApi({
      listDirs: vi.fn().mockResolvedValue({
        ok: true,
        data: [
          {
            id: 'p1',
            manifestText: '{"id":"p1"}',
            mainText: 'export default {}',
            stylesText: '.a{}',
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
      stylesText: '.a{}',
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
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('listDirs failed'),
      'EIO',
      'disk',
    );
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
