// 「跟随系统」解析出的主题:系统明暗 + 系统高对比度(VSCode window.autoDetectHighContrast 默认开)。
// 系统高对比度 = main 推送的 nativeTheme 判定(VSCode ThemeMainService.getColorScheme,含 macOS「反转颜色」与 Linux 高对比度,
// 渲染侧媒体查询看不到)或 渲染侧 (forced-colors: active) / (prefers-contrast: more)。明暗:main 判定为高对比度时用 main 的
// 明暗(Windows 高对比度黑 / 白看 shouldUseInvertedColorScheme),否则 prefers-color-scheme。
// 订阅按 Provider 挂载 / 卸载(主窗与 popout 宿主各一份),不做模块级单例。BDD: src/__tests__/high-contrast-theme/

import { useEffect, useState } from 'react';
import { coApi } from '@/lib/co-api';
import {
  systemResolvedTheme,
  type HostColorScheme,
} from '../../electron/shared/host-color-scheme';
import type { ResolvedTheme } from '../../electron/shared/window-background';

const DARK_QUERY = '(prefers-color-scheme: dark)';
const HIGH_CONTRAST_QUERIES = ['(forced-colors: active)', '(prefers-contrast: more)'] as const;

/** main 最近一次给出的系统配色(GET / 推送);非 React 调用方(切换浅深命令)同步解析时用。 */
let lastHost: HostColorScheme | null = null;

function matches(query: string): boolean | null {
  try {
    if (typeof globalThis.window?.matchMedia !== 'function') return null;
    return globalThis.window.matchMedia(query).matches;
  } catch {
    return null;
  }
}

/** 按 媒体查询 + main 判定 合成「跟随系统」的主题。matchMedia 不可用 → 暗色(默认主题)。 */
export function resolveSystemTheme(host: HostColorScheme | null = lastHost): ResolvedTheme {
  const mediaDark = matches(DARK_QUERY) ?? true;
  const mediaHighContrast = HIGH_CONTRAST_QUERIES.some((q) => matches(q) === true);
  if (host?.highContrast) return systemResolvedTheme(host);
  return systemResolvedTheme({ dark: mediaDark, highContrast: mediaHighContrast });
}

/**
 * 订阅一个媒体查询的变化。边界(E90):MediaQueryList 事件 API 不保证存在 —— 现代 add/removeEventListener,旧 WebKit /
 * 受限测试环境 / 畸形 polyfill 只有 addListener/removeListener,甚至都没有:feature-detect,都无则跳过(不让根 Provider 挂载抛错)。
 */
function subscribeQuery(query: string, onChange: () => void): () => void {
  let mql: MediaQueryList;
  try {
    if (typeof globalThis.window?.matchMedia !== 'function') return () => {};
    mql = globalThis.window.matchMedia(query);
  } catch {
    return () => {};
  }
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }
  if (typeof mql.addListener === 'function') {
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }
  return () => {};
}

/** 「跟随系统」时的主题(系统明暗 / 高对比度变化即更新)。 */
export function useSystemTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolveSystemTheme());
  useEffect(() => {
    let disposed = false;
    const update = (): void => {
      if (!disposed) setTheme(resolveSystemTheme());
    };
    const unsubs = [DARK_QUERY, ...HIGH_CONTRAST_QUERIES].map((q) => subscribeQuery(q, update));
    // main 判定:推送先于初值返回 → 初值已过期,丢弃(latest wins)。无 preload API(单测 / 旧 mock)→ 只用媒体查询。
    let pushed = false;
    try {
      unsubs.push(
        coApi.window.onHostColorSchemeChanged((scheme) => {
          pushed = true;
          lastHost = scheme;
          update();
        }),
      );
      coApi.window.getHostColorScheme().then(
        (r) => {
          if (pushed || !r.ok) return;
          lastHost = r.data;
          update();
        },
        () => {},
      );
    } catch {
      // 无 preload API
    }
    update(); // 挂载前媒体查询可能已变
    return () => {
      disposed = true;
      for (const unsub of unsubs) unsub();
    };
  }, []);
  return theme;
}

/** 仅测试:清掉 main 判定缓存。 */
export function _resetHostColorSchemeForTest(): void {
  lastHost = null;
}
