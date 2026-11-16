import type { Plugin } from 'vite';

// 回移 @xterm/addon-webgl 0.20 beta 的修复:AtlasPage.version 全局单调。
// 0.19.0 里 version 是每页各自从 0 计数,多个终端共享同一个 atlas,页合并后同一下标换成另一个
// 页对象时 version 可能恰好相等 → GlyphRenderer 跳过纹理上传 → 所有终端同时乱码,拖动窗口才恢复。
// 见 src/__tests__/terminal-webgl-atlas-page-version/README.md。升级 addon-webgl 后若锚点对不上,
// 这里直接报错:先看上游是否已修(修了就删掉本插件),没修再按新产物调整锚点。

export const ATLAS_PAGE_VERSION_COUNTER = '__continuoAtlasPageVersion';
const C = ATLAS_PAGE_VERSION_COUNTER;

// 每条对应 TextureAtlas.ts 里的一处 version 写入,压缩后的变量名不固定,用捕获组保留。
const REWRITES: ReadonlyArray<readonly [name: string, from: RegExp, to: string]> = [
  ['AtlasPage 构造', /this\._glyphs=\[\]([;,])this\.version=0([;,])/, `this._glyphs=[]$1this.version=++${C}$2`],
  ['AtlasPage.clear', /this\.fixedRows\.length=0,this\.version\+\+\}/, `this.fixedRows.length=0,this.version=++${C}}`],
  ['加字形', /(\w+)\.addGlyph\((\w+)\),\1\.version\+\+,/, `$1.addGlyph($2),$1.version=++${C},`],
  ['合并页', /(\w+)=this\._mergePages\((\w+),(\w+)\);\1\.version\+\+;/, `$1=this._mergePages($2,$3);$1.version=++${C};`],
  ['删页前移', /(\w+)\.texturePage--;(\w+)\.version\+\+\}/, `$1.texturePage--;$2.version=++${C}}`],
];

export function patchAtlasPageVersion(code: string): string {
  let out = code;
  for (const [name, from, to] of REWRITES) {
    const hits = out.match(new RegExp(from.source, 'g'))?.length ?? 0;
    if (hits !== 1) {
      throw new Error(`[xterm-webgl-atlas-version] @xterm/addon-webgl 产物里「${name}」锚点命中 ${hits} 次(应为 1),补丁需重新评估`);
    }
    out = out.replace(from, to);
  }
  return `var ${C}=0;${out}`;
}

const ADDON_WEBGL_BUNDLE = /[\\/]@xterm[\\/]addon-webgl[\\/]lib[\\/]addon-webgl\.m?js$/;

/** renderer 用。dev 下需配合 `optimizeDeps.exclude: ['@xterm/addon-webgl']`,否则预打包会绕过 transform。 */
export function xtermWebglAtlasVersionPlugin(): Plugin {
  return {
    name: 'continuo:xterm-webgl-atlas-version',
    enforce: 'pre',
    transform(code, id) {
      if (!ADDON_WEBGL_BUNDLE.test(id.split('?')[0]!)) return null;
      return { code: patchAtlasPageVersion(code), map: null };
    },
  };
}
