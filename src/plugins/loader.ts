// ESM 动态加载 + styles.css 注入(M-Plugin v1.3)。
// 不直接 import 而是接受 importer 注入,方便测试 + 主进程 / renderer 异路径。

import { Plugin } from './Plugin';
import type { CoPluginApp, Disposable, PluginManifest } from './types';
import { errorMessage } from '../../electron/shared/error-message';

// 可维护性 M3:动态 import 的 default export 是 Plugin **子类**(可实例化),但
// `typeof Plugin` 是 abstract 类型(不可 new)。用一个可构造的构造器类型表达「Plugin
// 子类构造器」,把动态 import 的信任边界(runtime subclass 校验后的 `as`)集中在本
// loader,调用方(PluginManager)就能直接 `new`,不必再 `as any` 关闭实例化检查。
export type PluginConstructor = new (
  app: CoPluginApp,
  manifest: PluginManifest,
) => Plugin;

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
  | { ok: true; PluginClass: PluginConstructor }
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
      message: errorMessage(err),
    };
  }

  const def = (mod as { default?: unknown } | null)?.default;
  if (def === undefined || def === null) {
    return {
      ok: false,
      code: 'NO_DEFAULT_EXPORT',
      // i18n(I4):message 仅作 fallback —— UI 经 errors.NO_DEFAULT_EXPORT catalog 渲染
      // (含 zh/ko)。这里改英文(开发者面向)去掉硬编码中文,避免 catalog 缺失时泄漏中文。
      message: `Plugin ${opts.manifest.id} has no default export`,
    };
  }
  if (typeof def !== 'function' || !isPluginSubclass(def)) {
    return {
      ok: false,
      code: 'NOT_PLUGIN_CLASS',
      // i18n(I4):同上,message 作 fallback,UI 经 errors.NOT_PLUGIN_CLASS catalog 渲染。
      message: `Plugin ${opts.manifest.id} default export is not a Plugin subclass`,
    };
  }

  // runtime 已校验 def 是 Plugin 子类(isPluginSubclass)→ 信任边界集中在此 cast。
  return { ok: true, PluginClass: def as PluginConstructor };
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
