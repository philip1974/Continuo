// ESM 动态加载(M-Plugin v1.3)。
// 不直接 import 而是接受 importer 注入,方便测试 + 主进程 / renderer 异路径。

import { Plugin } from './Plugin';
import type { CoPluginApp, PluginManifest } from './types';
import { errorMessage } from '../../electron/shared/error-message';
import type { IpcPluginSyntaxError } from '../../electron/shared/plugins-channels';
import { pluginLocationFromStack } from './plugin-source-url';

// 可维护性 M3:动态 import 的 default export 是 Plugin **子类**(可实例化),但
// `typeof Plugin` 是 abstract 类型(不可 new)。用一个可构造的构造器类型表达「Plugin
// 子类构造器」,把动态 import 的信任边界(runtime subclass 校验后的 `as`)集中在本
// loader,调用方(PluginManager)就能直接 `new`,不必再 `as any` 关闭实例化检查。
export type PluginConstructor = new (
  app: CoPluginApp,
  manifest: PluginManifest,
) => Plugin;

// ── module 加载 ────────────────────────────────────────

export type PluginModuleResult =
  | { ok: true; PluginClass: PluginConstructor }
  | {
      ok: false;
      /**
       * IMPORT_SYNTAX_ERROR:入口有语法错误(location 由 diagnose 给出,不执行代码);IMPORT_UNBUNDLED:入口 import 了
       * 相对 / 裸模块(params.specifier、params.kind = relative | bare)—— 插件须打包成单文件 ESM;其余 import 失败(含模块
       * 顶层代码抛错)为 IMPORT_FAILED(location 取自堆栈)。BDD: plugin-dev-experience。
       */
      code: 'IMPORT_FAILED' | 'IMPORT_SYNTAX_ERROR' | 'IMPORT_UNBUNDLED' | 'NO_DEFAULT_EXPORT' | 'NOT_PLUGIN_CLASS';
      message: string;
      params?: Readonly<Record<string, string>>;
      /** 出错位置 `<相对插件目录的文件>:<行>:<列>`。 */
      location?: string;
    };

export interface LoadPluginModuleOpts {
  readonly moduleUrl: string;
  readonly manifest: PluginManifest;
  /** 生产传 host.importModule(负责 Blob URL 解析与 revoke);测试注入 mock。 */
  readonly importer: (url: string) => Promise<unknown>;
  /** 可选:import 报 SyntaxError 时取行列号(只编译不执行;生产走 main 的 CHECK_MAIN_SYNTAX)。 */
  readonly diagnoseSyntax?: (url: string) => Promise<IpcPluginSyntaxError | null>;
}

// Chromium 的模块解析失败:`Failed to resolve module specifier "./util.js". …`
const UNRESOLVED_SPECIFIER_RE = /Failed to resolve module specifier ["']([^"']{1,512})["']/;

/** manifest.main → 位置里的文件名(去掉开头 ./、统一 /)。 */
function mainFileName(main: string | undefined): string {
  return (main ?? 'main.js').replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}

async function importFailure(opts: LoadPluginModuleOpts, err: unknown): Promise<PluginModuleResult> {
  const message = errorMessage(err);
  const unresolved = UNRESOLVED_SPECIFIER_RE.exec(message);
  if (unresolved) {
    const specifier = unresolved[1]!;
    const relative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
    return {
      ok: false,
      code: 'IMPORT_UNBUNDLED',
      message,
      params: { specifier, kind: relative ? 'relative' : 'bare' },
    };
  }
  if ((err as { name?: unknown } | null)?.name === 'SyntaxError' && opts.diagnoseSyntax) {
    let diag: IpcPluginSyntaxError | null = null;
    try {
      diag = await opts.diagnoseSyntax(opts.moduleUrl);
    } catch {
      diag = null;
    }
    if (diag) {
      return {
        ok: false,
        code: 'IMPORT_SYNTAX_ERROR',
        message: diag.message,
        location: `${mainFileName(opts.manifest.main)}:${diag.line}:${diag.column}`,
      };
    }
  }
  const location = pluginLocationFromStack((err as { stack?: unknown } | null)?.stack, opts.manifest.id);
  return { ok: false, code: 'IMPORT_FAILED', message, ...(location ? { location } : {}) };
}

export async function loadPluginModule(
  opts: LoadPluginModuleOpts,
): Promise<PluginModuleResult> {
  let mod: unknown;
  try {
    mod = await opts.importer(opts.moduleUrl);
  } catch (err) {
    return importFailure(opts, err);
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
  if (!isPluginSubclass(def)) {
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
