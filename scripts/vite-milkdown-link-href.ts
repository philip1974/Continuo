import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

// 修补 @milkdown/preset-commonmark(≥7.22)的 sanitizeLinkHref:它只放行 http/https/mailto/tel/ftp,
// 用 /^([a-z][a-z0-9+.-]*):/ 判 scheme → 盘符路径 `C:/a.md` 被当成 `C:` scheme。链接 mark 渲染(toDOM)
// 与链接气泡确认(confirmEdit)都走它:DOM href 为空(点击 / 复制失效),气泡不改内容回车 → mark 的
// href 被换成 "" → 保存成 `[x]()`。上游无配置项,故构建期把「白名单放行」改为「只清空危险 scheme」:
// javascript: / data: / vbscript: / file: 清空,其余(盘符路径 `C:/`、co: / vscode: / obsidian: 等自定义 scheme)
// 原样保留 —— 地址是用户文件内容,不能因编辑器不认识就在确认编辑时抹掉。打开与否另由 resolveLink 白名单决定
// (Milkdown 内链接点击一律 preventDefault 后交给它,DOM href 不会被直接导航)。见 src/__tests__/editor-markdown-link-href/README.md。
// 升级 Milkdown 后锚点对不上直接报错:先看上游是否已修(修了就删本插件),没修再按新产物调整锚点。

const REWRITES: ReadonlyArray<readonly [name: string, from: RegExp, to: string]> = [
  [
    '只清空危险 scheme',
    /if \(SAFE_PROTOCOLS\.has\(`\$\{scheme\.toLowerCase\(\)\}:`\)\) return trimmed;\s*return "";/,
    'return /^(?:javascript|data|vbscript|file)$/i.test(scheme) ? "" : trimmed;',
  ],
];

export function patchSanitizeLinkHref(code: string): string {
  let out = code;
  for (const [name, from, to] of REWRITES) {
    const hits = out.match(new RegExp(from.source, 'g'))?.length ?? 0;
    if (hits !== 1) {
      throw new Error(`[milkdown-link-href] @milkdown/preset-commonmark 产物里「${name}」锚点命中 ${hits} 次(应为 1),补丁需重新评估`);
    }
    out = out.replace(from, to);
  }
  return out;
}

const PRESET_COMMONMARK_BUNDLE = /[\\/]@milkdown[\\/]preset-commonmark[\\/]lib[\\/]index\.js$/;

/** renderer 构建(rollup)与 vitest(需把 @milkdown 设为 inline)用。 */
export function milkdownLinkHrefPlugin(): Plugin {
  return {
    name: 'continuo:milkdown-link-href',
    enforce: 'pre',
    transform(code, id) {
      if (!PRESET_COMMONMARK_BUNDLE.test(id.split('?')[0]!)) return null;
      return { code: patchSanitizeLinkHref(code), map: null };
    },
  };
}

/** dev 预打包(optimizeDeps 走 esbuild,绕过 vite transform)用。 */
export function milkdownLinkHrefEsbuildPlugin() {
  return {
    name: 'continuo:milkdown-link-href',
    setup(build: { onLoad: (o: { filter: RegExp }, cb: (a: { path: string }) => Promise<{ contents: string; loader: 'js' }>) => void }) {
      build.onLoad({ filter: PRESET_COMMONMARK_BUNDLE }, async ({ path }) => ({
        contents: patchSanitizeLinkHref(await readFile(path, 'utf-8')),
        loader: 'js',
      }));
    },
  };
}
