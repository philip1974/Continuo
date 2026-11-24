import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

// 修补 @milkdown/preset-commonmark(≥7.22)的 sanitizeLinkHref:它只放行 http/https/mailto/tel/ftp,
// 用 /^([a-z][a-z0-9+.-]*):/ 判 scheme → 盘符路径 `C:/a.md` 被当成 `C:` scheme。链接 mark 渲染(toDOM)
// 与链接气泡确认(confirmEdit)都走它:DOM href 为空(点击 / 复制失效),气泡不改内容回车 → mark 的
// href 被换成 "" → 保存成 `[x]()`。上游无配置项,故构建期改两处:
//   - 盘符路径(`C:\` / `C:/`)按无 scheme 处理,原样放行;
//   - 放行 Continuo 自有 co: 与 vscode:(打开仍由 resolveLink 白名单决定,这里只保证地址不被清空)。
// javascript: / data: / vbscript: / file: 等仍清空。见 src/__tests__/editor-markdown-link-href/README.md。
// 升级 Milkdown 后锚点对不上直接报错:先看上游是否已修(修了就删本插件),没修再按新产物调整锚点。

const REWRITES: ReadonlyArray<readonly [name: string, from: RegExp, to: string]> = [
  ['scheme 白名单', /("ftp:")(\s*\]\);)/, '$1, "co:", "vscode:"$2'],
  ['无 scheme 放行', /if \(!scheme\) return trimmed;/, 'if (!scheme || /^[a-z]:[\\\\/]/i.test(normalized)) return trimmed;'],
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
