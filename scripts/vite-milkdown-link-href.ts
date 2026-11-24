import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

// 修补 @milkdown/preset-commonmark(≥7.22)的 sanitizeLinkHref:它只放行 http/https/mailto/tel/ftp,
// 用 /^([a-z][a-z0-9+.-]*):/ 判 scheme → 盘符路径 `C:/a.md` 被当成 `C:` scheme。链接 mark 渲染(toDOM)、
// 链接气泡预览(<a href>)与气泡确认(confirmEdit)都走它:DOM href 为空(点击 / 复制失效),气泡不改内容回车
// → mark 的 href 被换成 "" → 保存成 `[x]()`。上游无配置项,故构建期修补产物:
// 1. preset-commonmark:sanitizeLinkHref 由「白名单放行」改为「只清空危险 scheme」(javascript: / data: /
//    vbscript: / file: 清空,盘符路径、co: / vscode: / obsidian: 等自定义 scheme 原样保留)—— 只用于 DOM 渲染。
// 2. components 的链接气泡:confirmEdit 不再 sanitize,存用户输入(trim 后)—— 地址是用户文件内容,不能因编辑器
//    不认识或不让渲染就在确认编辑时抹掉;输入与原 href 相同时照上游走 no-op 分支。危险 scheme 的 DOM href 仍由 1 清空。
// 打开与否另由 resolveLink 白名单决定(拒绝 file: 等;Milkdown 内链接点击一律 preventDefault 后交给它,DOM href
// 不会被直接导航)。见 src/__tests__/editor-markdown-link-href/README.md。
// 3. 输入法组合(IME):链接气泡输入框与 Crepe 斜杠菜单(window 捕获阶段)的 keydown 不判组合 → zh / ko 用户组合中按
//    Enter 上屏 / Esc 撤销拼音 / 方向键选候选会被当成确认 / 取消 / 移动高亮。两处 keydown 开头加组合判断(组合中直接返回,
//    交给输入法)。见 src/__tests__/editor-markdown-ime-composition/README.md。
// 升级 Milkdown 后锚点对不上直接报错:先看上游是否已修(修了就删本插件),没修再按新产物调整锚点。

type Rewrite = readonly [name: string, from: RegExp, to: string];

const SANITIZE_REWRITES: readonly Rewrite[] = [
  [
    '只清空危险 scheme',
    /if \(SAFE_PROTOCOLS\.has\(`\$\{scheme\.toLowerCase\(\)\}:`\)\) return trimmed;\s*return "";/,
    'return /^(?:javascript|data|vbscript|file)$/i.test(scheme) ? "" : trimmed;',
  ],
];

const TOOLTIP_CONFIRM_REWRITES: readonly Rewrite[] = [
  [
    'confirmEdit 存用户输入、不 sanitize',
    /const link = sanitizeLinkHref\(href\);/,
    'const link = typeof href === "string" ? href.trim() : "";',
  ],
  [
    '气泡输入框 keydown 组合中交给输入法',
    /const onKeydown = \(e\) => \{\s*e\.stopPropagation\(\);/,
    'const onKeydown = (e) => {\n      e.stopPropagation();\n      if (e.isComposing || e.keyCode === 229) return;',
  ],
];

const CREPE_SLASH_REWRITES: readonly Rewrite[] = [
  [
    '斜杠菜单 keydown 组合中交给输入法',
    /const onKeydown = \(e\) => \{\s*const \{ size, groups \} = groupInfo\.value;/,
    'const onKeydown = (e) => {\n      if (e.isComposing || e.keyCode === 229) return;\n      const { size, groups } = groupInfo.value;',
  ],
];

function applyRewrites(code: string, pkg: string, rewrites: readonly Rewrite[]): string {
  let out = code;
  for (const [name, from, to] of rewrites) {
    const hits = out.match(new RegExp(from.source, 'g'))?.length ?? 0;
    if (hits !== 1) {
      throw new Error(`[milkdown-link-href] ${pkg} 产物里「${name}」锚点命中 ${hits} 次(应为 1),补丁需重新评估`);
    }
    out = out.replace(from, to);
  }
  return out;
}

export function patchSanitizeLinkHref(code: string): string {
  return applyRewrites(code, '@milkdown/preset-commonmark', SANITIZE_REWRITES);
}

export function patchLinkTooltipConfirm(code: string): string {
  return applyRewrites(code, '@milkdown/components link-tooltip', TOOLTIP_CONFIRM_REWRITES);
}

export function patchCrepeSlashMenuKeydown(code: string): string {
  return applyRewrites(code, '@milkdown/crepe slash menu', CREPE_SLASH_REWRITES);
}

const PRESET_COMMONMARK_BUNDLE = /[\\/]@milkdown[\\/]preset-commonmark[\\/]lib[\\/]index\.js$/;
const LINK_TOOLTIP_BUNDLE = /[\\/]@milkdown[\\/]components[\\/]lib[\\/]link-tooltip[\\/]index\.js$/;
// `@milkdown/crepe` 主入口(内联了 block-edit)与子路径入口 `feature/block-edit` 各有一份斜杠菜单。
const CREPE_SLASH_BUNDLE = /[\\/]@milkdown[\\/]crepe[\\/]lib[\\/]esm[\\/](?:feature[\\/]block-edit[\\/])?index\.js$/;
const PATCHED_BUNDLE = new RegExp(
  `${PRESET_COMMONMARK_BUNDLE.source}|${LINK_TOOLTIP_BUNDLE.source}|${CREPE_SLASH_BUNDLE.source}`,
);

function patchBundle(code: string, id: string): string | null {
  if (PRESET_COMMONMARK_BUNDLE.test(id)) return patchSanitizeLinkHref(code);
  if (LINK_TOOLTIP_BUNDLE.test(id)) return patchLinkTooltipConfirm(code);
  if (CREPE_SLASH_BUNDLE.test(id)) return patchCrepeSlashMenuKeydown(code);
  return null;
}

/** renderer 构建(rollup)与 vitest(需把 @milkdown 设为 inline)用。 */
export function milkdownLinkHrefPlugin(): Plugin {
  return {
    name: 'continuo:milkdown-link-href',
    enforce: 'pre',
    transform(code, id) {
      const patched = patchBundle(code, id.split('?')[0]!);
      return patched === null ? null : { code: patched, map: null };
    },
  };
}

/** dev 预打包(optimizeDeps 走 esbuild,绕过 vite transform)用。 */
export function milkdownLinkHrefEsbuildPlugin() {
  return {
    name: 'continuo:milkdown-link-href',
    setup(build: { onLoad: (o: { filter: RegExp }, cb: (a: { path: string }) => Promise<{ contents: string; loader: 'js' }>) => void }) {
      build.onLoad({ filter: PATCHED_BUNDLE }, async ({ path }) => ({
        contents: patchBundle(await readFile(path, 'utf-8'), path)!,
        loader: 'js',
      }));
    },
  };
}
