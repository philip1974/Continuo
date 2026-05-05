// 入境清洗(M-Plugin v5 Phase 4):
//
// plugin 与 LM 同 realm,无法 hide window.api。但 plugin 不该绕过
// app.network/app.clipboard 直接用 raw globalThis.fetch / navigator.clipboard。
// 本模块在 module 顶部缓存 raw 引用(用 .bind 保证 this),scoped-app
// 通过 getter 取用;sandboxSweep() 在 plugin import 前把 globalThis 的
// 入口涂掉,plugin 调 fetch(...) 直接抛 TypeError 'fetch is not a function'。
//
// 注意:dev 模式下 Vite HMR / 某些库可能依赖 globalThis.fetch,本函数
// 应**只在 PROD** 调用(import.meta.env.PROD 守卫)。dev 保留 raw 让
// plugin 作者验证 try/catch 模式即可,prod 严格执行。
//
// window.api 不在本次 sweep 范围(LM UI 41 处直接用,refactor 过大);
// 见 doc/11 Phase 4.B 后续路线。

const RAW_FETCH: typeof fetch =
  typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : ((() => {
        throw new Error('globalThis.fetch 在 module load 时不存在');
      }) as typeof fetch);

interface ClipboardOps {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

const RAW_CLIPBOARD: ClipboardOps =
  typeof navigator !== 'undefined' && navigator.clipboard
    ? {
        readText: navigator.clipboard.readText.bind(navigator.clipboard),
        writeText: navigator.clipboard.writeText.bind(navigator.clipboard),
      }
    : {
        readText: () => {
          throw new Error('navigator.clipboard 在 module load 时不存在');
        },
        writeText: () => {
          throw new Error('navigator.clipboard 在 module load 时不存在');
        },
      };

export function getCachedFetch(): typeof fetch {
  return RAW_FETCH;
}

export function getCachedClipboard(): ClipboardOps {
  return RAW_CLIPBOARD;
}

/**
 * 入境清洗:删 globalThis.fetch + navigator.clipboard + window.api,plugin
 * 直接调这些 API 会抛 TypeError。LM UI 自身通过 getCachedFetch/Clipboard /
 * lmApi 走缓存,不受影响。
 *
 * 调用时机:LM 内核 init 完成,user PluginManager init **之前**。
 * dev 模式不要调(Vite HMR 可能要 fetch);PROD 才调。
 *
 * Phase 4.B 加 window.api sweep:plugin 不能再走 window.api.fs.* 绕过
 * app.fs 的权限门。LM UI 走 lmApi(captureLmApi 已缓存)不受影响。
 */
export function sandboxSweep(): void {
  // 用 defineProperty 覆盖 — 直接 delete 在 chromium 上是 no-op
  // (browser globals 多为 non-configurable,需 redefine)
  try {
    Object.defineProperty(globalThis, 'fetch', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  } catch (err) {
    console.warn('[sandbox-sweep] fetch sweep 失败', err);
  }
  try {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  } catch (err) {
    console.warn('[sandbox-sweep] clipboard sweep 失败', err);
  }
  // window.api / globalThis.api:preload 改用 __lmApi 后正常 PROD 不存在,
  // 这两条主要防御 dev/手挂 / 老 preload 残留场景。
  try {
    Object.defineProperty(globalThis, 'api', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    if (typeof window !== 'undefined' && (window as { api?: unknown }).api) {
      Object.defineProperty(window, 'api', {
        value: undefined,
        writable: true,
        configurable: true,
      });
    }
  } catch (err) {
    console.warn('[sandbox-sweep] window.api sweep 失败', err);
  }
  // window.__lmApi:contextBridge 设为 non-configurable,defineProperty 必失败。
  // 仍 try 以防未来 Electron 改默认值;失败静默(已知限制)。
  try {
    Object.defineProperty(globalThis, '__lmApi', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  } catch {
    /* 已知:contextBridge non-configurable,见 doc/11 Phase 4.B 残留 */
  }
}
