import { describe, expect, it, vi } from 'vitest';
import {
  parseContinuoHostnameFromArgv,
} from '../../../electron/preload/continuo-meta-parse';

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    send: vi.fn(),
    sendSync: vi.fn(() => 1),
    removeListener: vi.fn(),
  },
  webUtils: {
    getPathForFile: vi.fn(),
  },
}));

describe('topic 48 preload metadata bridge', () => {
  it('parses the hostname argument; absent / empty → null', () => {
    expect(
      parseContinuoHostnameFromArgv(['node', 'exe.cjs', '--continuo-hostname=my-mac.local']),
    ).toBe('my-mac.local');
    expect(parseContinuoHostnameFromArgv(['node', '--continuo-hostname='])).toBeNull();
    expect(parseContinuoHostnameFromArgv(['node', 'exe.cjs'])).toBeNull();
  });

  it('exposes Continuo metadata through coApi.system only (no __continuoMeta)', async () => {
    vi.resetModules();
    const electron = await import('electron');
    const exposeInMainWorld = vi.mocked(electron.contextBridge.exposeInMainWorld);
    const originalArgv = process.argv;

    process.argv = [
      'node',
      'exe.cjs',
      '--continuo-hostname=my-mac.local',
      '--continuo-windows-build=19045',
    ];
    try {
      await import('../../../electron/preload/index');
    } finally {
      process.argv = originalArgv;
    }

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(exposeInMainWorld.mock.calls.some(([key]) => key === '__continuoMeta')).toBe(false);
    // 本机 hostname 经 coApi.system.hostname 同步暴露(OSC7 acceptedHosts 用)
    const bootstrap = exposeInMainWorld.mock.calls[0]?.[1] as {
      claimRendererApi: () => {
        system: { hostname: string | null; windowsBuild: number | null };
      } | null;
    };
    const system = bootstrap.claimRendererApi()?.system;
    expect(system?.hostname).toBe('my-mac.local');
    // Windows build 号(main 仅 win32 注入)经 coApi.system.windowsBuild 暴露(终端 xterm windowsPty 用)
    expect(system?.windowsBuild).toBe(19045);
  });
});
