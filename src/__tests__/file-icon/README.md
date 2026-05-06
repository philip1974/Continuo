# file-icon(资源管理器文件图标化)

行为契约:**根据文件名 / 扩展名 / 目录名映射到对应图标**(参考 VSCode
file icon themes)。覆盖范围:常见编程语言扩展、主流配置文件、特殊目录名。
未命中走通用 fallback(Document / Folder),不抛错。

> 配套:`@react-symbols/icons` 326 个 Symbols 风格彩色图标(已在依赖,
> Vite tree-shake 自动只 bundle 用到的)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Explorer/file-icon.tsx` | `getFileIconComponent(name, isDirectory)` + `<FileIcon>` 组件;3 张映射表 + fallback 逻辑 |

需 export 的形态(供本主题断言):

```ts
import type { ComponentType } from 'react';
import {
  Document, Folder, TypeScript, Reactts, Markdown, NPM,
  FolderSrc, FolderNodeModules, /* ... */
} from '@react-symbols/icons';

type IconComp = ComponentType<{ width: number; height: number }>;

export function getFileIconComponent(
  name: string,
  isDirectory: boolean,
): IconComp;

export function FileIcon(props: {
  name: string;
  isDirectory: boolean;
  size?: number;  // 默认 16
}): JSX.Element;
```

## 关键行为

### 目录(isDirectory=true)

- 特殊目录名(case-insensitive)→ 专用 Folder* icon:
  - `src` / `Src` → `FolderSrc`
  - `node_modules` → `FolderNodeModules`
  - `.github` → `FolderGithub`
  - `.vscode` → `FolderVSCode`
  - `assets` / `public` / `static` → `FolderAssets`
  - `images` / `img` → `FolderImages`
  - `hooks` → `FolderHooks`
  - `routes` / `pages` / `router` → `FolderRouter`
  - `utils` → `FolderUtils`
  - `services` → `FolderServices`
  - `models` → `FolderModels`
  - `types` / `typings` / `interfaces` → `FolderInterfaces`
  - `config` / `configs` → `FolderConfig`
  - `constants` → `FolderConstants`
  - `context` / `contexts` → `FolderContext`
  - `providers` → `FolderProviders`
  - `shared` → `FolderShared`
  - `core` → `FolderCore`
  - `layout` / `layouts` → `FolderLayout`
  - `modules` → `FolderModules`
  - `docs` / `doc` → `FolderDocuments`
  - `dist` / `build` / `out` / `.next` / `.nuxt` → `FolderBuild`
- 未命中 → `Folder`(通用)

### 文件(isDirectory=false)

按优先级:

1. **特殊文件名精确匹配**(case-sensitive 优先,失败再 case-insensitive)
   - `package.json` / `package-lock.json` → `NPM`
   - `pnpm-lock.yaml` / `pnpm-workspace.yaml` → `PNPM`
   - `yarn.lock` → `Yarn`
   - `bun.lockb` / `bun.lock` → `Bun`
   - `tsconfig.json` / `jsconfig.json` → `Tsconfig`
   - `vite.config.{ts,js,mts}` → `Vite`
   - `vitest.config.{ts,js}` → `Vitest`
   - `eslint.config.{js,mjs,ts}` / `.eslintrc*` → `Eslint`
   - `.prettierrc*` / `prettier.config.js` → `Prettier`
   - `tailwind.config.{js,ts,cjs}` → `Tailwind`
   - `biome.{json,jsonc}` → `Biome`
   - `.gitignore` / `.gitattributes` / `.gitmodules` → `Ignore`
   - `README` / `README.md` → `Markdown`
   - `LICENSE` / `LICENSE.{md,txt}` → `License`
   - `Dockerfile` / `docker-compose.{yml,yaml}` / `.dockerignore` → `Docker`
   - `.env` / `.env.{local,development,production}` → `Lock`
   - `.editorconfig` → `EditorConfig`
   - `next.config.{js,ts,mjs}` → `Next`
   - `nuxt.config.{ts,js}` → `Nuxt`
   - `astro.config.{mjs,ts}` → `Astro`

2. **`.d.ts` 后缀**(特殊优先于通用 ext)→ `Dts`

3. **扩展名映射**(case-insensitive,取最后一段)
   - 编程语言:`ts/mts/cts → TypeScript` / `tsx → Reactts` / `js/mjs/cjs → Js` /
     `jsx → Reactjs` / `py → Python` / `rb → Ruby` / `go → Go` / `rs → Rust` /
     `java → Java` / `kt → Kotlin` / `swift → Swift` / `php → PHP` /
     `cs → Csharp` / `c/h → CLang` / `cpp/cc/cxx/hpp → Cplus` / `lua → Lua` /
     `vue → Vue` / `svelte → Svelte` / `astro → Astro` / `dart → Dart` /
     `nix → Nix`
   - 数据:`json/jsonc → BracketsYellow` / `yaml/yml → Yaml` /
     `toml → BracketsOrange` / `xml → XML` / `csv → Csv` / `sql → Database`
   - 文档:`md → Markdown` / `mdx → MDX` / `txt/log → Text`
   - 网页:`html/htm → CodeOrange` / `css → Css` / `scss/sass → Sass` /
     `styl → Stylus` / `svg → SVG`
   - 图像:`png/jpg/jpeg/gif/webp/ico/bmp → Image`
   - 音频:`mp3/wav/ogg/flac/m4a → Audio`
   - 视频:`mp4/mov/webm/avi/mkv → Video`
   - 文档/包:`pdf → PDF` / `zip/tar/gz/7z/rar → Zip` / `exe/app/dmg → Exe`
   - shell:`sh/bash/zsh/fish → Shell`
   - 数据科学:`ipynb → Notebook`
   - protocol:`proto → Proto` / `graphql/gql → Graphql` / `prisma → Prisma`

4. **未命中** → `Document`

### 边界情况

- 隐藏文件(`.bashrc` / `.zshrc` 等)无 ext 也无特殊名 → `Document`(不当 ext)
- 多点文件名(`vite.config.ts`)取最后一段为 ext;但特殊名 `vite.config.ts`
  会先在 step 1 命中 `Vite`,不会到 step 3
- 空名 `''` → `Document`(不抛错)
- 大小写不影响 ext / 目录映射(`.PNG` 同 `.png`)
- 大小写**影响**特殊文件名首次匹配(`README` 命中 `Markdown`,但 `Readme`
  也命中 `Markdown` 因为 case-insensitive 兜底)

### 不在本主题验证

- `<FileIcon>` 组件渲染细节(width/height 透传给 react-symbols 即可,
  react-symbols 自己保证 SVG 输出正确)
- FileRow 接入(由 explorer-tree / FileRow 自己的 spec 测,本 topic 只测
  纯函数 `getFileIconComponent`)
- 未来 plugin 通过 ExplorerDecoratorRegistry 贡献 icon(V2,Decoration
  接口扩 `icon?` 字段后再加 spec)
