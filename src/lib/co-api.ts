// LM UI 内部 IPC 入口(M-Plugin v5 Phase 4.B)。
//
// 取代散落在源文件里的 `window.api.X.Y(...)` 直接访问。captureLmApi() 在
// main.tsx 早期调用一次,把 preload 注入的 window.api 缓存到 module-local;
// sandbox-sweep 之后 plugin 拿不到 window.api,但 LM UI 通过 coApi 仍能访问。
//
// `coApi` 用 Proxy 转发:
//   - 已 capture → 走缓存
//   - 未 capture → fallback 到 globalThis.window.api(测试 / jsdom 场景)
//   - 都没有 → 抛错
//
// 设计权衡:Proxy 每次访问要走 trap,但 IPC 本身就是异步开销大头,Proxy
// 这点纳秒级延迟不可见。换来源文件里 import { coApi } from '@/lib/co-api'
// 比 window.api 显式得多,sandbox 边界也清晰。

import type { ContinuoApi } from '../../electron/preload';

interface WindowWithApi {
  api?: ContinuoApi;
  __lmApi?: ContinuoApi;
}

function readLiveApi(): ContinuoApi | undefined {
  const w = (globalThis as unknown as { window?: WindowWithApi }).window;
  // PROD:preload 暴露 __lmApi。dev / 测试可能 mock window.api。
  return w?.__lmApi ?? w?.api;
}

let _cached: ContinuoApi | null = null;

/**
 * 把当前 window.__lmApi(PROD)或 window.api(测试 mock)缓存下来。
 * **main.tsx 启动时必须调一次,sandboxSweep 之前**。
 * 缺 → warn 不抛,后续 coApi 调用才报。
 */
export function captureLmApi(): void {
  const api = readLiveApi();
  if (!api) {
    console.warn('[lm-api] window.__lmApi/api 未注入,LM UI 后续调用会抛');
    return;
  }
  _cached = api;
}

/** 测试用:重置缓存(单元测试隔离). */
export function _resetLmApiForTest(): void {
  _cached = null;
}

/**
 * LM UI 唯一 IPC 入口。源文件用 `coApi.fs.readFile(...)`。
 *
 * Proxy 转发:已 capture 走缓存,否则 fallback 到 globalThis
 * (测试可通过 mock window.api 或 window.__lmApi 注入)。
 */
export const coApi = new Proxy({} as ContinuoApi, {
  get(_target, prop) {
    if (_cached) return _cached[prop as keyof ContinuoApi];
    const live = readLiveApi();
    if (!live) {
      throw new Error(
        `[lm-api] 访问 coApi.${String(prop)} 时 window.__lmApi/api 未注入,且未 captureLmApi()`,
      );
    }
    return live[prop as keyof ContinuoApi];
  },
});
