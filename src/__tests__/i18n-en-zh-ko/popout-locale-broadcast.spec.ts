import { afterEach, describe, expect, it, vi } from 'vitest';

type Locale = 'en' | 'zh' | 'ko';
type LocaleModule = {
  readonly setCurrentLocale: (
    locale: Locale,
    sourceWindowId?: number,
  ) => void | Promise<void>;
};

type MockWindow = {
  readonly id: number;
  readonly webContents: {
    readonly send: (channel: string, payload: unknown) => void;
    readonly getURL: () => string;
  };
  readonly isDestroyed: () => boolean;
};

const electronMock = vi.hoisted(() => ({
  BrowserWindow: {
    getAllWindows: vi.fn<() => MockWindow[]>(() => []),
  },
}));

vi.mock('electron', () => electronMock);

async function importPending<T>(moduleId: string): Promise<T> {
  return (await import(moduleId)) as T;
}

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

afterEach(() => {
  vi.clearAllMocks();
});

describe('popout locale broadcast', () => {
  it('mock 2 个 BrowserWindow，A 调 setLocale → B onChange callback 1s 内触发', async () => {
    vi.useFakeTimers();
    const a = makeWindow(1);
    const b = makeWindow(2);
    electronMock.BrowserWindow.getAllWindows.mockReturnValue([a, b]);
    const { setCurrentLocale } = await importPending<LocaleModule>(
      '../../../electron/main/i18n-main',
    );

    await setCurrentLocale('zh', a.id);
    await vi.advanceTimersByTimeAsync(1000);

    expect(b.webContents.send).toHaveBeenCalledWith(
      'i18n:changed',
      expect.objectContaining({ locale: 'zh' }),
    );
    expect(a.webContents.send).not.toHaveBeenCalledWith(
      'i18n:changed',
      expect.anything(),
    );
    vi.useRealTimers();
  });
});
