// 窗口底色主题(renderer 经 window:notify-theme 上报的 light / dark + 主题模式)的内存态与持久化。
// 对齐 VSCode ThemeMainService:主题变化时把背景色存进 userData,下次冷启动首个窗口就用它做 backgroundColor,
// 亮色用户开窗不先闪深色。独立小文件而不进 settings.json:后者是 {version, locale} 严格 schema,加字段会让
// 旧版本把新文件当损坏隔离(丢掉语言设置)。
// 文件只是「上次主题」缓存:缺失 / 损坏 / 超大 / 读失败一律回退默认暗色,不隔离、不抛。
// BDD: src/__tests__/window-background-theme/
import path from 'node:path';
import { app, nativeTheme } from 'electron';
import { z } from 'zod';
import { atomicWriteJson } from '../lib/atomic-write';
import { readFileCappedFd } from '../lib/read-fh-capped';
import { createSerialQueue } from '../../shared/run-serial-per-key';
import {
  RESOLVED_THEME_VALUES,
  THEME_MODE_VALUES,
  type ResolvedTheme,
} from '../../shared/window-background';
import {
  hostColorSchemeFromNativeTheme,
  systemResolvedTheme,
  type HostColorScheme,
} from '../../shared/host-color-scheme';

export const WINDOW_THEME_FILE_NAME = 'window-theme.json';
const MAX_FILE_BYTES = 4 * 1024;

const WindowThemeSchema = z.object({
  theme: z.enum(RESOLVED_THEME_VALUES),
  /** 主题模式;system 时冷启动按 OS 当前外观(nativeTheme,含高对比度)决定,不用上次解析值。旧数据 / 未上报时可缺省。 */
  mode: z.enum(THEME_MODE_VALUES).optional(),
});
export type WindowThemeState = z.infer<typeof WindowThemeSchema>;

const DEFAULT_STATE: WindowThemeState = { theme: 'dark' };
let state: WindowThemeState = DEFAULT_STATE;
// 已落盘内容(序列化),相同则跳过写盘。
let persisted: string | null = null;
const writeQueue = createSerialQueue();

const themeFile = (): string => path.join(app.getPath('userData'), WINDOW_THEME_FILE_NAME);

/** 系统当前配色(VSCode ThemeMainService.getColorScheme;高对比度含 Windows 高对比度、macOS 增强对比度 / 反转颜色)。 */
export function getHostColorScheme(): HostColorScheme {
  return hostColorSchemeFromNativeTheme(process.platform, nativeTheme);
}

/** 当前窗口底色主题:system 模式跟随 OS 当前外观(含高对比度),否则用最近上报 / 持久化的解析值。 */
export function getWindowTheme(): ResolvedTheme {
  if (state.mode === 'system') return systemResolvedTheme(getHostColorScheme());
  return state.theme;
}

/** 启动时(创建首个窗口前)读取上次主题。永不抛。 */
export async function loadWindowTheme(): Promise<void> {
  try {
    const r = await readFileCappedFd(themeFile(), MAX_FILE_BYTES);
    if (r.tooLarge) return;
    const parsed = WindowThemeSchema.safeParse(JSON.parse(r.text as string));
    if (!parsed.success) return;
    state = parsed.data;
    persisted = JSON.stringify(parsed.data);
  } catch {
    // 缺文件(首次启动)/ JSON 损坏 / 读失败:保持默认
  }
}

/** renderer 上报主题:内存态立即更新(之后新建窗口生效),持久化串行异步进行,失败只告警。 */
export function setWindowTheme(next: WindowThemeState): void {
  state = next.mode === undefined ? { theme: next.theme } : { theme: next.theme, mode: next.mode };
  void writeQueue
    .run(async () => {
      // 写入执行时的最新状态:连续上报只落最后一次,不会乱序覆盖
      const payload = JSON.stringify(state);
      if (payload === persisted) return;
      await atomicWriteJson(themeFile(), state);
      persisted = payload;
    })
    .catch((err: unknown) => console.warn('[window-theme] persist failed', err));
}

/** Test helper:等待在途写盘完成。 */
export function flushWindowThemeForTest(): Promise<void> {
  return writeQueue.run(async () => undefined);
}

/** Test helper:清内存态(模拟进程重启)。 */
export function _resetWindowThemeForTest(): void {
  state = DEFAULT_STATE;
  persisted = null;
  writeQueue.reset();
}
