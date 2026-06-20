import { describe, expect, it, vi } from 'vitest';
import { parseContinuoPackagedFromArgv } from '../../../electron/preload/continuo-meta-parse';

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
  it('parses a true packaged argument', () => {
    expect(
      parseContinuoPackagedFromArgv([
        'node',
        'exe.cjs',
        '--continuo-packaged=true',
      ]),
    ).toBe(true);
  });

  it('parses a false packaged argument', () => {
    expect(
      parseContinuoPackagedFromArgv([
        'node',
        'exe.cjs',
        '--continuo-packaged=false',
      ]),
    ).toBe(false);
  });

  it('preserves unknown state when the packaged argument is absent', () => {
    expect(parseContinuoPackagedFromArgv(['node', 'exe.cjs'])).toBeNull();
  });

  it('exposes frozen Continuo metadata through contextBridge', async () => {
    vi.resetModules();
    const electron = await import('electron');
    const exposeInMainWorld = vi.mocked(electron.contextBridge.exposeInMainWorld);
    const originalArgv = process.argv;

    process.argv = ['node', 'exe.cjs', '--continuo-packaged=true'];
    try {
      await import('../../../electron/preload/index');
    } finally {
      process.argv = originalArgv;
    }

    expect(exposeInMainWorld).toHaveBeenCalledTimes(2);
    expect(exposeInMainWorld).toHaveBeenCalledWith('__continuoMeta', {
      appIsPackaged: true,
    });
    expect(Object.isFrozen(exposeInMainWorld.mock.calls[1]?.[1])).toBe(true);
  });
});
