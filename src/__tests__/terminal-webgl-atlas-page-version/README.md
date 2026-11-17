# terminal-webgl-atlas-page-version

行为契约:多个 Terminal 同时打开时,WebGL 字形缓存(texture atlas)发生页合并后,
**每个**终端都必须把变化的页重新上传到自己的 GPU 纹理,不能出现「所有终端同时乱码、
拖动窗口改变大小才恢复」。

## 现象

两个 Terminal 各跑不同任务,偶尔同时整屏乱码(每个格子画成 atlas 里另一个字形);
拖动窗口改变大小后恢复。

## 根因(`@xterm/addon-webgl` 0.19.0)

- 字体/主题/DPR/格子尺寸相同的终端共用同一个 `TextureAtlas`(`CharAtlasCache.ts`
  模块级缓存);每个终端有自己的 WebGL context 和纹理。
- 页数达到上限(macOS 约 16)时 `_createNewPage` 把 4 页合并成 1 页,后面的页**前移**,
  并让所有共享终端整屏重画。
- `GlyphRenderer.render` 只按「同一下标的页 version 是否相等」决定是否重新上传纹理;
  而 version 是**每页各自从 0 计数**的。前移到下标 i 的新页 version 可能恰好等于该下标
  旧页的 version → 跳过上传 → GPU 里还是旧页像素,字形按新索引取 → 乱码。共享 atlas
  上的合并同时作用于所有终端,所以一起乱。
- 拖动窗口 → `handleResize` → `setAtlas` 把所有纹理 version 置 -1 → 强制全量上传,所以恢复。

## 修复

回移上游修复(`@xterm/addon-webgl` 0.20 beta:「AtlasPage.version is globally monotonic,
so a page object swap at the same index (which happens after a page merge) is detected」):
所有 AtlasPage 的 version 写入都取自一个模块级单调递增计数器,任何两个页对象的 version
永不相等。

实现为 renderer 的 Vite transform 插件(`scripts/vite-xterm-webgl-atlas-version.ts`),
而非 `pnpm patch`:本机装依赖用 pnpm 11(不读 package.json 的 `pnpm` 字段),CI 用 pnpm 9,
补丁登记位置与 lockfile 两边对不上。dev 下 Vite 会用 esbuild 预打包依赖并绕过 transform,
所以 `@xterm/addon-webgl` 必须在 `optimizeDeps.exclude` 里。

## 规范

- 已安装的打包产物(`lib/addon-webgl.mjs` 供 Vite,`lib/addon-webgl.js` 供 CJS)仍是
  per-page 计数 —— 补丁仍有必要;上游正式版修好后此条失败,提示删补丁。
- 补丁后 AtlasPage 的 5 处 version 写入(构造、加字形、清空、合并、删页前移)全部取自同一个
  单调计数器,不再有 per-page 的 `version++` / `version=0`,产物仍可解析。
- 锚点对不上(上游改了实现)时补丁直接报错,构建失败,不静默放过。
- renderer 构建与 dev 都经过补丁(插件注册 + 不预打包)。
