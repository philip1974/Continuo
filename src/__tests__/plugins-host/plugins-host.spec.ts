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

  it('ok=false → console.warn + 空 Set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installFakeApi({
      readEnabled: vi.fn().mockResolvedValue({
        ok: false,
        code: 'NOENT',
        message: 'missing',
      }),
    });
    const host = createWindowApiHost();
    const set = await host.readEnabledIds();
    expect(set.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('readEnabled failed'),
      'NOENT',
      'missing',
    );
  });
});

describe('createWindowApiHost.writeEnabledIds', () => {
  it('ok=true → 把 ids 透传给 IPC,不抛', async () => {
    const writeEnabled = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({ writeEnabled });

    const host = createWindowApiHost();
    await host.writeEnabledIds(['x', 'y']);
    expect(writeEnabled).toHaveBeenCalledWith(['x', 'y']);
  });

  it('ok=false → console.warn,不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installFakeApi({
      writeEnabled: vi.fn().mockResolvedValue({
        ok: false,
        code: 'EACCES',
        message: 'denied',
      }),
    });

    const host = createWindowApiHost();
    await expect(host.writeEnabledIds(['a'])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('writeEnabled failed'),
      'EACCES',
      'denied',
    );
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
