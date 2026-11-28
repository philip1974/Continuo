// @vitest-environment jsdom
// renderer 首帧主题:入口模块(main.tsx)在加载样式 / React 之前,按设置值同步给 <html> 定好 dark class,
// 亮色用户首帧不先画深色。见同目录 README「冷启动」一节。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyInitialThemeClass, readInitialTheme } from '@/theme/initial-theme';
import { SETTINGS_VALUES_STORAGE_KEY } from '@/plugins/settings/storage-key';
import { GENERAL_THEME } from '@/plugins/settings/core-setting-specs';
import { createFakeUserSettingsMain, uninstallUserSettingsHost } from '../_helpers/fake-user-settings-main';

const html = document.documentElement;
const setStored = (record: unknown): void =>
  localStorage.setItem(SETTINGS_VALUES_STORAGE_KEY, typeof record === 'string' ? record : JSON.stringify(record));
const mockSystem = (dark: boolean): void => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({ matches: q === '(prefers-color-scheme: dark)' ? dark : false })),
  );
};

beforeEach(() => {
  localStorage.clear();
  html.classList.add('dark'); // index.html 静态默认
  mockSystem(true);
});
afterEach(() => {
  uninstallUserSettingsHost();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  html.classList.remove('dark');
});

describe('readInitialTheme / applyInitialThemeClass', () => {
  it('设置值 light → 去掉 dark class', () => {
    setStored({ [GENERAL_THEME.id]: 'light' });
    expect(readInitialTheme()).toBe('light');
    applyInitialThemeClass();
    expect(html.classList.contains('dark')).toBe(false);
  });

  it('设置值 dark → 保留 dark class', () => {
    setStored({ [GENERAL_THEME.id]: 'dark' });
    applyInitialThemeClass();
    expect(html.classList.contains('dark')).toBe(true);
  });

  it.each([
    [false, 'light'],
    [true, 'dark'],
  ] as const)('system:按 prefers-color-scheme(dark=%s → %s)', (dark, expected) => {
    setStored({ [GENERAL_THEME.id]: 'system' });
    mockSystem(dark);
    expect(readInitialTheme()).toBe(expected);
  });

  it.each([
    ['无记录', undefined],
    ['JSON 损坏', '{oops'],
    ['值非法', { [GENERAL_THEME.id]: 'sepia' }],
    ['非对象', '[1,2]'],
    ['原型链上的键不算', '{"__proto__":{"general.theme":"light"}}'],
  ])('%s → 默认主题(%s)', (_label, record) => {
    if (record !== undefined) setStored(record);
    expect(readInitialTheme()).toBe(GENERAL_THEME.default === 'system' ? 'dark' : GENERAL_THEME.default);
  });

  it('localStorage 访问抛错 → 默认主题,不抛', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => applyInitialThemeClass()).not.toThrow();
    expect(html.classList.contains('dark')).toBe(true);
  });
});

// 设置值的权威存储在 main(user-settings.json):首帧经同步 IPC 快照读,不读 localStorage;
// 只有 main 文件尚未建立(首次启动新版本,待迁移)时才读旧 localStorage 记录。
describe('首帧来源:main 快照', () => {
  it('已迁移 → 用 main 快照里的主题,不看旧 localStorage', () => {
    setStored({ [GENERAL_THEME.id]: 'dark' }); // 陈旧的旧记录
    createFakeUserSettingsMain({ settings: { record: { [GENERAL_THEME.id]: 'light' } } }).install();
    expect(readInitialTheme()).toBe('light');
    applyInitialThemeClass();
    expect(html.classList.contains('dark')).toBe(false);
  });

  it('待迁移(main 文件原本不存在)→ 用旧 localStorage 记录(迁移过程中首帧也正确)', () => {
    setStored({ [GENERAL_THEME.id]: 'light' });
    createFakeUserSettingsMain({ settings: { needsImport: true } }).install();
    expect(readInitialTheme()).toBe('light');
  });

  it('快照读取抛错 → 默认主题,不抛', () => {
    const w = globalThis as unknown as { window: { api?: Record<string, unknown> } };
    w.window.api = {
      userSettings: {
        snapshot: () => {
          throw new Error('ipc down');
        },
      },
    };
    expect(() => applyInitialThemeClass()).not.toThrow();
    expect(html.classList.contains('dark')).toBe(true);
  });
});

describe('接线', () => {
  const read = (rel: string): string => readFileSync(resolve(__dirname, '../..', rel), 'utf-8');

  it('main.tsx 在动态 import main-app(样式 + React)之前同步调用 applyInitialThemeClass()', () => {
    const src = read('main.tsx');
    const call = src.indexOf('applyInitialThemeClass()');
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(src.indexOf("import('./main-app')"));
  });

  it('设置值 store 与首帧读取用同一来源(main 快照的 settings 记录 / 同一个旧 localStorage 键)', () => {
    const store = read('plugins/settings/values-store.ts');
    expect(store).toMatch(/scope: 'settings'/);
    expect(store).toMatch(/legacyKey: SETTINGS_VALUES_STORAGE_KEY/);
    expect(read('theme/initial-theme.ts')).toMatch(/initialUserSettingsRecord\('settings', SETTINGS_VALUES_STORAGE_KEY\)/);
  });
});
