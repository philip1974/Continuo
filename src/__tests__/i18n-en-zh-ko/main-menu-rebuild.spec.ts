import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18N_CHANNELS } from '../../../electron/shared/i18n-channels';
import type { Locale } from '../../../electron/shared/i18n-types';

type SafeHandler<I, O> = (input: I) => O | Promise<O>;
type SafeHandleCall = {
  readonly channel: string;
  readonly handler: SafeHandler<unknown, unknown>;
};
type PopoutWindow = {
  readonly webContents: {
    readonly getURL: () => string;
    readonly send: (channel: string, payload: unknown) => void;
  };
  readonly setMenu: (menu: unknown) => void;
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
  setCurrentLocale: vi.fn<(locale: Locale) => Promise<number> | number>(() => 1),
  getSetLocaleGen: vi.fn<() => number>(() => 1),
  // race(R36):handler 改用 commitSetLocaleGen 判广播(true=最新成功提交)。
  commitSetLocaleGen: vi.fn<(gen: number) => boolean>(() => true),
  getCurrentLocale: vi.fn<() => Locale>(() => 'en'),
  BrowserWindow: {
    getAllWindows: vi.fn<() => PopoutWindow[]>(() => []),
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

describe('main menu rebuild on setLocale', () => {
  it('registerI18nIpc 注册 GET/SET handler，SET_LOCALE 成功后调用 menu rebuilder', async () => {
    const { registerI18nIpc, setMenuRebuilder } = await import(
      '../../../electron/main/ipc/i18n.ipc'
    );
    const rebuild = vi.fn();

    registerI18nIpc(() => true);
    setMenuRebuilder(rebuild);
    await setLocaleHandler()('zh');

    expect(mocks.safeHandle).toHaveBeenCalledTimes(2);
    expect(mocks.safeHandleCalls.map((call) => call.channel)).toEqual([
      I18N_CHANNELS.GET_LOCALE,
      I18N_CHANNELS.SET_LOCALE,
    ]);
    expect(mocks.setCurrentLocale).toHaveBeenCalledWith('zh');
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('SET_LOCALE 重建 application menu 不 touch popout window.setMenu(null)', async () => {
    const popout: PopoutWindow = {
      webContents: {
        getURL: () => 'file:///renderer/index.html?popout=1',
        send: vi.fn(),
      },
      setMenu: vi.fn(),
      isDestroyed: () => false,
    };
    mocks.BrowserWindow.getAllWindows.mockReturnValue([popout]);
    const { registerI18nIpc, setMenuRebuilder } = await import(
      '../../../electron/main/ipc/i18n.ipc'
    );

    registerI18nIpc(() => true);
    setMenuRebuilder(vi.fn());
    await setLocaleHandler()('ko');

    expect(popout.setMenu).not.toHaveBeenCalled();
  });
});
