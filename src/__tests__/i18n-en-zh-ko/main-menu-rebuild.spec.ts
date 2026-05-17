import { afterEach, describe, expect, it, vi } from 'vitest';

type Locale = 'en' | 'zh' | 'ko';
type MenuModule = {
  readonly setCurrentLocale: (locale: Locale) => void | Promise<void>;
  readonly buildAppMenu: () => unknown;
};

type PopoutWindow = {
  readonly webContents: { readonly getURL: () => string };
  readonly setMenu: (menu: unknown) => void;
};

const electronMock = vi.hoisted(() => ({
  Menu: {
    setApplicationMenu: vi.fn<(menu: unknown) => void>(),
    buildFromTemplate: vi.fn<(template: unknown) => unknown>((template) => ({
      template,
    })),
  },
  BrowserWindow: {
    getAllWindows: vi.fn<() => PopoutWindow[]>(() => []),
  },
}));

vi.mock('electron', () => electronMock);

async function importPending<T>(moduleId: string): Promise<T> {
  return (await import(moduleId)) as T;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('main menu rebuild on setLocale', () => {
  it('setCurrentLocale("zh") 后调用 Menu.setApplicationMenu 一次', async () => {
    const { setCurrentLocale } = await importPending<MenuModule>(
      '../../../electron/main/i18n-main',
    );

    await setCurrentLocale('zh');

    expect(electronMock.Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
  });

  it('重建 template 使用 getMainT() 当前值（File label = "文件"）', async () => {
    const menu = await importPending<MenuModule>(
      '../../../electron/main/i18n-main',
    );

    await menu.setCurrentLocale('zh');
    menu.buildAppMenu();

    expect(electronMock.Menu.buildFromTemplate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ label: '文件' })]),
    );
  });

  it('application menu rebuild 不 touch popout 窗（popout 仍是 setMenu(null)）', async () => {
    const popout: PopoutWindow = {
      webContents: { getURL: () => 'file:///renderer/index.html?popout=1' },
      setMenu: vi.fn(),
    };
    electronMock.BrowserWindow.getAllWindows.mockReturnValue([popout]);
    const { setCurrentLocale } = await importPending<MenuModule>(
      '../../../electron/main/i18n-main',
    );

    await setCurrentLocale('ko');

    expect(popout.setMenu).not.toHaveBeenCalled();
  });
});
