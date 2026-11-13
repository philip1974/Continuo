// plugin-data / plugin-fs raw IPC 的 frame-trust 门(守卫未传播到兄弟入口:shell-stream 有,这两组没有)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: {}, ipcMain: {}, app: {} }));

import {
  assertTrustedFrame,
  withTrustedFrameGate,
} from '../../../electron/main/safe-handle';
import { IPC_ERR } from '../../../electron/shared/ipc-result';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function makeIpcMain() {
  const handlers = new Map<string, Handler>();
  const on = vi.fn();
  return {
    handlers,
    on,
    ipcMain: {
      handle: (channel: string, fn: Handler) => void handlers.set(channel, fn),
      on,
    },
  };
}

const TRUSTED = { url: 'trusted://app' };
const isTrusted = (frame: { url: string } | null): boolean => frame?.url === TRUSTED.url;

describe('withTrustedFrameGate', () => {
  it('可信 frame → 透传全部参数与返回值', async () => {
    const { ipcMain, handlers } = makeIpcMain();
    const fn = vi.fn(async (_e: unknown, a: unknown, b: unknown) => `${String(a)}-${String(b)}`);
    withTrustedFrameGate(ipcMain as never, isTrusted).handle('ch', fn as never);

    const event = { senderFrame: TRUSTED, sender: { id: 1 } };
    await expect(handlers.get('ch')!(event, 'x', 'y')).resolves.toBe('x-y');
    expect(fn).toHaveBeenCalledWith(event, 'x', 'y');
  });

  it.each([
    ['其它 origin 的 frame', { url: 'https://evil.example' }],
    ['senderFrame 为 null(frame 已销毁)', null],
  ])('%s → DENIED,handler 不执行', async (_label, senderFrame) => {
    const { ipcMain, handlers } = makeIpcMain();
    const fn = vi.fn();
    withTrustedFrameGate(ipcMain as never, isTrusted).handle('ch', fn as never);

    await expect(
      Promise.resolve().then(() => handlers.get('ch')!({ senderFrame }, 'p.victim')),
    ).rejects.toMatchObject({ code: IPC_ERR.DENIED });
    expect(fn).not.toHaveBeenCalled();
  });

  it('ipcMain 的其它方法原样转发', () => {
    const { ipcMain, on } = makeIpcMain();
    const listener = (): void => {};
    (withTrustedFrameGate(ipcMain as never, isTrusted) as unknown as typeof ipcMain).on(
      'evt',
      listener,
    );
    expect(on).toHaveBeenCalledWith('evt', listener);
  });

  it('assertTrustedFrame:不可信抛 DENIED,可信不抛', () => {
    expect(() => assertTrustedFrame({ senderFrame: TRUSTED } as never, isTrusted)).not.toThrow();
    expect(() => assertTrustedFrame({ senderFrame: null } as never, isTrusted)).toThrow(
      'sender frame is not trusted',
    );
  });
});

describe('接线守卫:生产注册点传入 gated ipcMain', () => {
  const read = (rel: string): string =>
    readFileSync(join(process.cwd(), 'electron/main', rel), 'utf-8');

  it('plugin-data.ipc.ts', () => {
    expect(read('ipc/plugin-data.ipc.ts')).toMatch(
      /registerPluginDataStoreHandlers\(\s*withTrustedFrameGate\(/,
    );
  });

  it('plugin-fs.ipc.ts', () => {
    expect(read('ipc/plugin-fs.ipc.ts')).toMatch(
      /registerPluginFsHandlers\(\s*withTrustedFrameGate\(/,
    );
  });

  it('plugin-shell-stream 用同一个 assertTrustedFrame', () => {
    const src = read('services/plugin-shell-stream.service.ts');
    expect((src.match(/assertTrustedFrame\(event\)/g) ?? []).length).toBe(2);
    expect(src).not.toContain('defaultIsTrustedFrame(event.senderFrame)');
  });
});
