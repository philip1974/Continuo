// renderer 首帧主题:入口模块(main.tsx)在动态加载样式与 React(main-app)之前同步调用,按设置值 general.theme
// 给 <html> 定好 dark class。index.html 静态写的是 class="dark"(默认主题),亮色用户若等 ThemeProvider 挂载后的
// effect 才去掉,样式先到的那一帧会画成深色。CSP(script-src 'self')不允许 index.html 内联脚本,入口模块是
// 最早能执行的同源脚本。之后由 ThemeProvider 接管(同一设置值,结果一致)。
// 只依赖无运行时依赖的模块,保持入口 chunk 轻量。BDD: src/__tests__/window-background-theme/
import { GENERAL_THEME } from '@/plugins/settings/core-setting-specs';
import { SETTINGS_VALUES_STORAGE_KEY } from '@/plugins/settings/storage-key';
import { ownValue } from '../../electron/shared/own-value';

// 与 values-store 读端同一原始串上限(1 MiB):超限视为无记录,不在启动关键路径上解析超大 JSON。
const MAX_RAW_LENGTH = 1024 * 1024;

function storedThemeMode(): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_VALUES_STORAGE_KEY);
    if (!raw || raw.length > MAX_RAW_LENGTH) return undefined;
    const record: unknown = JSON.parse(raw);
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined;
    return ownValue(record as Record<string, unknown>, GENERAL_THEME.id);
  } catch {
    return undefined; // localStorage 被禁用 / JSON 损坏:按默认主题
  }
}

function systemTheme(): 'light' | 'dark' {
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === false ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** 按设置值解析首帧主题(system 跟随 prefers-color-scheme;无效 / 缺失 → 默认主题)。 */
export function readInitialTheme(): 'light' | 'dark' {
  const stored = storedThemeMode();
  const mode = stored === 'light' || stored === 'dark' || stored === 'system' ? stored : GENERAL_THEME.default;
  return mode === 'system' ? systemTheme() : mode;
}

export function applyInitialThemeClass(): void {
  globalThis.document?.documentElement.classList.toggle('dark', readInitialTheme() === 'dark');
}
