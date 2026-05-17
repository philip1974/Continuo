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
});
