// LM UI 内部 IPC 入口(M-Plugin v5 Phase 4.B)。
//
// 取代散落在源文件里的 `window.api.X.Y(...)` 直接访问。captureLmApi() 在
// main.tsx 早期调用一次,把 preload 注入的 window.api 缓存到 module-local;
// sandbox-sweep 之后 plugin 拿不到 window.api,但 LM UI 通过 lmApi 仍能访问。
//
// `lmApi` 用 Proxy 转发:
//   - 已 capture → 走缓存
//   - 未 capture → fallback 到 globalThis.window.api(测试 / jsdom 场景)
//   - 都没有 → 抛错
//
// 设计权衡:Proxy 每次访问要走 trap,但 IPC 本身就是异步开销大头,Proxy
// 这点纳秒级延迟不可见。换来源文件里 import { lmApi } from '@/lib/lm-api'
// 比 window.api 显式得多,sandbox 边界也清晰。

import type { LayoutMotionApi } from '../../electron/preload';

let _cached: LayoutMotionApi | null = null;

/**
 * 把当前 window.api 缓存下来。**main.tsx 启动时必须调一次,sandboxSweep 之前**。
 * 缺 window.api(jsdom 测试常见)→ warn 不抛,后续 lmApi 调用才报。
 */
export function captureLmApi(): void {
  const api = (globalThis as unknown as { window?: { api?: LayoutMotionApi } })
    .window?.api;
  if (!api) {
    console.warn('[lm-api] window.api 未注入,LM UI 后续调用会抛');
    return;
  }
  _cached = api;
}

/** 测试用:重置缓存(单元测试隔离). */
export function _resetLmApiForTest(): void {
  _cached = null;
}

/**
 * LM UI 唯一 IPC 入口。源文件用 `lmApi.fs.readFile(...)` 取代 `window.api.fs.readFile(...)`。
 *
 * Proxy 转发:已 capture 走缓存,否则 fallback 到 globalThis(测试可通过 mock window.api 注入)。
 */
export const lmApi = new Proxy({} as LayoutMotionApi, {
  get(_target, prop) {
    if (_cached) return _cached[prop as keyof LayoutMotionApi];
    // 未 capture:回看 globalThis(测试 mock 的窗口)
    const live = (
      globalThis as unknown as { window?: { api?: LayoutMotionApi } }
    ).window?.api;
    if (!live) {
      throw new Error(
        `[lm-api] 访问 lmApi.${String(prop)} 时 window.api 未注入,且未 captureLmApi()`,
      );
    }
    return live[prop as keyof LayoutMotionApi];
  },
});
