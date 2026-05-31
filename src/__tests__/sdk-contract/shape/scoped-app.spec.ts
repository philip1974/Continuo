import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      requestScope: vi.fn().mockResolvedValue('grant'),
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
      userHome: vi.fn().mockResolvedValue('/home/test'),
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

import { createScopedApp } from '../../../plugins/scoped-app';
import {
  InMemoryPermissionStore,
  PermissionError,
} from '../../../plugins/permissions';
import type { CoApp } from '../../../plugins/types';

function makeCoApp(): CoApp {
  return {
    version: '0.0.0-test',
    dataStore: {
      read: vi.fn(),
      write: vi.fn(),
    },
    workspace: {
      getRoot: vi.fn(),
    },
    commands: {},
    panels: {},
    statusBar: {},
    ribbon: {},
    events: {},
    settingTabs: {},
    settingItems: {},
    explorerDecorators: {},
    editorActions: {},
    explorerContextMenu: {},
    mcp: {
      register: vi.fn(),
    },
  } as unknown as CoApp;
}

beforeEach(() => {
  vi.clearAllMocks();
  coApiMocks.pluginFsRaw.readFile.mockResolvedValue('mock content');
  coApiMocks.shellExec.mockResolvedValue({
    ok: true,
    data: {
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
    },
  });
});

describe('sdk-contract shape: ScopedApp permission and token contract', () => {
  it('T3.a grants fs.readFile and forwards through token-bound coApi', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('plugin.a', ['fs']);
    const scoped = createScopedApp(makeCoApp(), 'plugin.a', store, 'token-a');

    await expect(scoped.fs.readFile('/tmp/a.txt')).resolves.toBe('mock content');
    expect(coApiMocks.pluginFsRaw.readFile).toHaveBeenCalledWith(
      'token-a',
      '/tmp/a.txt',
    );
  });

  it('T3.b denies fs.readFile before reaching coApi when fs is not granted', async () => {
    const store = new InMemoryPermissionStore();
    const scoped = createScopedApp(makeCoApp(), 'plugin.a', store, 'token-a');

    await expect(scoped.fs.readFile('/tmp/a.txt')).rejects.toBeInstanceOf(
      PermissionError,
    );
    expect(coApiMocks.pluginFsRaw.readFile).not.toHaveBeenCalled();
  });

  it('T3.c skips permission checks when store is null and forwards fs.readFile', async () => {
    const scoped = createScopedApp(makeCoApp(), 'plugin.a', null, 'token-a');

    await expect(scoped.fs.readFile('/tmp/a.txt')).resolves.toBe('mock content');
    expect(coApiMocks.pluginFsRaw.readFile).toHaveBeenCalledWith(
      'token-a',
      '/tmp/a.txt',
    );
  });

  it('T3.d throws no-token error for fs calls when permission passes but token is missing', async () => {
    const store = new InMemoryPermissionStore();
    await store.grant('plugin.a', ['fs']);
    const scoped = createScopedApp(makeCoApp(), 'plugin.a', store);

    await expect(scoped.fs.readFile('/tmp/a.txt')).rejects.toThrow(
      '[plugin-fs] no token bound',
    );
  });

  it('T3.e gates shell.exec on shell permission', async () => {
    const store = new InMemoryPermissionStore();
    const denied = createScopedApp(makeCoApp(), 'plugin.a', store);
    await expect(denied.shell.exec('echo', ['hi'])).rejects.toBeInstanceOf(
      PermissionError,
    );

    await store.grant('plugin.a', ['shell']);
    const granted = createScopedApp(makeCoApp(), 'plugin.a', store);
    await expect(granted.shell.exec('echo', ['hi'])).resolves.toMatchObject({
      stdout: 'ok',
    });
    expect(coApiMocks.shellExec).toHaveBeenCalledWith({
      cmd: 'echo',
      args: ['hi'],
      cwd: undefined,
      env: undefined,
      timeoutMs: undefined,
      input: undefined,
      maxOutputBytes: undefined,
    });
  });

  it('T3.f gates network.fetch on network permission', async () => {
    const store = new InMemoryPermissionStore();
    const scoped = createScopedApp(makeCoApp(), 'plugin.a', store);

    await expect(
      scoped.network.fetch('https://example.com'),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it('T3.g gates clipboard.readText on clipboard permission', async () => {
    const store = new InMemoryPermissionStore();
    const scoped = createScopedApp(makeCoApp(), 'plugin.a', store);

    await expect(scoped.clipboard.readText()).rejects.toBeInstanceOf(
      PermissionError,
    );
  });
});
