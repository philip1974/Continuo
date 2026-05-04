// ESM 动态加载 + styles.css 注入(M-Plugin v1.3)。
// 不直接 import 而是接受 importer 注入,方便测试 + 主进程 / renderer 异路径。

import { Plugin } from './Plugin';
import type { Disposable, PluginManifest } from './types';

// ── styles 注入 ────────────────────────────────────────

/**
 * 把插件的 styles.css 文本注入到 <head>,返回 Disposable。
 * 同 scopeId 重复注入会替换旧的(不累积)。
 */
export function injectStyles(css: string, scopeId: string): Disposable {
  if (typeof document === 'undefined') {
    return { dispose: () => {} };
  }
  // 同 scopeId 旧 style 先删(plugin id schema 限制 [a-z0-9._-],
  // 不需要 CSS.escape;直接拼即可,jsdom 也不带 CSS.escape)
  const existing = document.head.querySelector(
    `style[data-plugin-id="${scopeId}"]`,
  );
  if (existing) existing.remove();

  const style = document.createElement('style');
  style.setAttribute('data-plugin-id', scopeId);
  style.textContent = css;
  document.head.appendChild(style);

  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      style.remove();
    },
  };
}

// ── module 加载 ────────────────────────────────────────

export type PluginModuleResult =
  | { ok: true; PluginClass: typeof Plugin }
  | {
      ok: false;
      code: 'IMPORT_FAILED' | 'NO_DEFAULT_EXPORT' | 'NOT_PLUGIN_CLASS';
      message: string;
    };

export interface LoadPluginModuleOpts {
  readonly moduleUrl: string;
  readonly manifest: PluginManifest;
  /** 测试可注入 mock,生产用 (url) => import(/* @vite-ignore *​/ url). */
  readonly importer?: (url: string) => Promise<unknown>;
}

const defaultImporter = (url: string) =>
  import(/* @vite-ignore */ url) as Promise<unknown>;

export async function loadPluginModule(
  opts: LoadPluginModuleOpts,
): Promise<PluginModuleResult> {
  const importer = opts.importer ?? defaultImporter;
  let mod: unknown;
  try {
    mod = await importer(opts.moduleUrl);
  } catch (err) {
    return {
      ok: false,
      code: 'IMPORT_FAILED',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const def = (mod as { default?: unknown } | null)?.default;
  if (def === undefined || def === null) {
    return {
      ok: false,
      code: 'NO_DEFAULT_EXPORT',
      message: `Plugin ${opts.manifest.id} 没有 export default`,
    };
  }
  if (typeof def !== 'function' || !isPluginSubclass(def)) {
    return {
      ok: false,
      code: 'NOT_PLUGIN_CLASS',
      message: `Plugin ${opts.manifest.id} 的 default export 不是 Plugin 子类`,
    };
  }

  return { ok: true, PluginClass: def as typeof Plugin };
}

function isPluginSubclass(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  // 走 prototype chain 判断是否继承自 Plugin
  let proto: unknown = fn;
  while (proto) {
    if (proto === Plugin) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}
