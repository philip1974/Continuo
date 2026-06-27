import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18N_CHANNELS } from '../../../electron/shared/i18n-channels';
import type { Locale } from '../../../electron/shared/i18n-types';

type SafeHandler<I, O> = (input: I) => O | Promise<O>;
type SafeHandleCall = {
  readonly channel: string;
  readonly handler: SafeHandler<unknown, unknown>;
};
type MockWindow = {
  readonly id: number;
  readonly webContents: {
    readonly send: (channel: string, payload: unknown) => void;
    readonly getURL: () => string;
  };
  readonly isDestroyed: () => boolean;
};

const mocks = vi.hoisted(() => ({
  safeHandleCalls: [] as SafeHandleCall[],
  safeHandle: vi.fn(
    (
      channel: string,
      _schema: unknown,
      handler: SafeHandler<unknown, unknown>,
      _trusted: unknown,
    ) => {
      mocks.safeHandleCalls.push({ channel, handler });
    },
  ),
  setCurrentLocale: vi.fn<(locale: Locale) => Promise<number> | number>(() => 2),
  getSetLocaleGen: vi.fn<() => number>(() => 2),
  // race(R36):handler 改用 commitSetLocaleGen 判广播(true=最新成功提交)。
  commitSetLocaleGen: vi.fn<(gen: number) => boolean>(() => true),
  getCurrentLocale: vi.fn<() => Locale>(() => 'en'),
  BrowserWindow: {
    getAllWindows: vi.fn<() => MockWindow[]>(() => []),
  },
}));

vi.mock('../../../electron/main/safe-handle', () => ({
  safeHandle: mocks.safeHandle,
}));

vi.mock('../../../electron/main/services/settings.service', () => ({
  getCurrentLocale: mocks.getCurrentLocale,
  setCurrentLocale: mocks.setCurrentLocale,
  getSetLocaleGen: mocks.getSetLocaleGen,
  commitSetLocaleGen: mocks.commitSetLocaleGen,
}));

vi.mock('electron', () => ({
  BrowserWindow: mocks.BrowserWindow,
}));

function makeWindow(id: number): MockWindow {
  return {
    id,
    webContents: {
      send: vi.fn(),
      getURL: () => `file:///renderer/index.html?window=${id}`,
    },
    isDestroyed: () => false,
  };
}

function setLocaleHandler(): SafeHandler<Locale, unknown> {
  const call = mocks.safeHandleCalls.find(
    (item) => item.channel === I18N_CHANNELS.SET_LOCALE,
  );
  if (!call) throw new Error('missing SET_LOCALE safeHandle registration');
  return call.handler as SafeHandler<Locale, unknown>;
}

afterEach(() => {
  mocks.safeHandleCalls.length = 0;
  vi.clearAllMocks();
});

describe('popout locale broadcast', () => {
  it('SET_LOCALE broadcast 到所有未销毁 BrowserWindow', async () => {
    const win1 = makeWindow(1);
    const win2 = makeWindow(2);
    mocks.BrowserWindow.getAllWindows.mockReturnValue([win1, win2]);
    const { registerI18nIpc, setMenuRebuilder } = await import(
      '../../../electron/main/ipc/i18n.ipc'
    );

    registerI18nIpc(() => true);
    setMenuRebuilder(vi.fn());
    await setLocaleHandler()('ko');

    const payload = { locale: 'ko', gen: 2 };
    expect(win1.webContents.send).toHaveBeenCalledWith(
      I18N_CHANNELS.CHANGED,
      payload,
    );
    expect(win2.webContents.send).toHaveBeenCalledWith(
      I18N_CHANNELS.CHANGED,
      payload,
    );
  });

  // race(R64,R63 同族):一个窗口 send 抛错(isDestroyed 检查后销毁)不应中断广播或让
  // SET_LOCALE 返回 ok:false —— locale 已落 disk/main,handler 失败会让发起 renderer 停旧语言。
  it('R64: 一个窗口 send 抛错 → 其它窗口仍收到广播 + handler 仍返回 ok', async () => {
    const dead = makeWindow(1);
    (dead.webContents.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
    const healthy = makeWindow(2);
    mocks.BrowserWindow.getAllWindows.mockReturnValue([dead, healthy]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { registerI18nIpc, setMenuRebuilder } = await import(
      '../../../electron/main/ipc/i18n.ipc'
    );

    registerI18nIpc(() => true);
    setMenuRebuilder(vi.fn());
    const result = await setLocaleHandler()('ko');

    // 抛错窗口之后的健康窗口仍收到广播(循环未中断)。
    expect(healthy.webContents.send).toHaveBeenCalledWith(
      I18N_CHANNELS.CHANGED,
      { locale: 'ko', gen: 2 },
    );
    // handler 不因单窗口 send 失败而返回 ok:false(否则发起 renderer 不更新语言 = 分裂)。
    expect(result).toEqual({ ok: true, locale: 'ko', gen: 2 });
  });
});
