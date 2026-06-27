// 资源管理器文件图标化(V1)。
// 根据文件名 / 扩展名 / 目录名映射到 @react-symbols/icons 的彩色图标。
// 未命中走 Document / Folder fallback。tree-shake 让 Vite 只 bundle 用到的 icon。
//
// V2 规划:扩 ExplorerDecoratorRegistry 让 plugin 贡献 icon(git modified
// 状态、license badge 等)。
//
// BDD: src/__tests__/file-icon/

import type { ComponentType } from 'react';
import {
  // 通用 fallback
  Document,
  Folder,
  // 编程语言
  TypeScript,
  Reactts,
  Js,
  Reactjs,
  Dts,
  Python,
  Ruby,
  Go,
  Rust,
  Java,
  Kotlin,
  Swift,
  PHP,
  Csharp,
  CLang,
  Cplus,
  Lua,
  Vue,
  Svelte,
  Astro,
  Dart,
  Nix,
  // 数据 / 文档
  Yaml,
  XML,
  Csv,
  Markdown,
  MDX,
  Text,
  Database,
  Notebook,
  Proto,
  Graphql,
  Prisma,
  // 网页(react-symbols 无 Css 单独 icon → BracketsBlue 当通用样式表色)
  Sass,
  Stylus,
  SVG,
  // 媒体
  Image,
  Audio,
  Video,
  PDF,
  Zip,
  Exe,
  // shell
  Shell,
  // 包管理 / 配置
  NPM,
  PNPM,
  Yarn,
  Bun,
  Tsconfig,
  Vite,
  Vitest,
  Eslint,
  Prettier,
  Tailwind,
  Biome,
  Docker,
  License,
  Lock,
  EditorConfig,
  Next,
  Nuxt,
  Ignore,
  // 通用色块兜底(json/toml/css/html 没专门 icon)
  BracketsYellow,
  BracketsOrange,
  BracketsBlue,
  CodeOrange,
  // 文件夹
  FolderSrc,
  FolderNodeModules,
  FolderGithub,
  FolderGitlab,
  FolderVSCode,
  FolderAssets,
  FolderImages,
  FolderFonts,
  FolderHooks,
  FolderRouter,
  FolderUtils,
  FolderHelpers,
  FolderServices,
  FolderModels,
  FolderInterfaces,
  FolderMiddleware,
  FolderConfig,
  FolderConstants,
  FolderContext,
  FolderProviders,
  FolderShared,
  FolderCore,
  FolderLayout,
  FolderModules,
  FolderDocuments,
  FolderBuild,
} from '@react-symbols/icons';

type IconComp = ComponentType<{ width: number; height: number }>;

// 特殊文件名(精确,case-sensitive 优先,大小写不敏感兜底)
const SPECIAL_FILE_NAMES: Readonly<Record<string, IconComp>> = {
  'package.json': NPM,
  'package-lock.json': NPM,
  'pnpm-lock.yaml': PNPM,
  'pnpm-workspace.yaml': PNPM,
  'yarn.lock': Yarn,
  'bun.lockb': Bun,
  'bun.lock': Bun,
  'tsconfig.json': Tsconfig,
  'jsconfig.json': Tsconfig,
  'vite.config.ts': Vite,
  'vite.config.js': Vite,
  'vite.config.mts': Vite,
  'vite.config.mjs': Vite,
  'vitest.config.ts': Vitest,
  'vitest.config.js': Vitest,
  'eslint.config.js': Eslint,
  'eslint.config.mjs': Eslint,
  'eslint.config.ts': Eslint,
  '.eslintrc': Eslint,
  '.eslintrc.json': Eslint,
  '.eslintrc.js': Eslint,
  '.eslintrc.cjs': Eslint,
  '.prettierrc': Prettier,
  '.prettierrc.json': Prettier,
  '.prettierrc.js': Prettier,
  'prettier.config.js': Prettier,
  'tailwind.config.js': Tailwind,
  'tailwind.config.ts': Tailwind,
  'tailwind.config.cjs': Tailwind,
  'biome.json': Biome,
  'biome.jsonc': Biome,
  '.gitignore': Ignore,
  '.gitattributes': Ignore,
  '.gitmodules': Ignore,
  README: Markdown,
  'README.md': Markdown,
  'README.markdown': Markdown,
  LICENSE: License,
  'LICENSE.md': License,
  'LICENSE.txt': License,
  Dockerfile: Docker,
  'docker-compose.yml': Docker,
  'docker-compose.yaml': Docker,
  '.dockerignore': Docker,
  '.env': Lock,
  '.env.local': Lock,
  '.env.development': Lock,
  '.env.production': Lock,
  '.env.test': Lock,
  '.editorconfig': EditorConfig,
  'next.config.js': Next,
  'next.config.ts': Next,
  'next.config.mjs': Next,
  'nuxt.config.ts': Nuxt,
  'nuxt.config.js': Nuxt,
  'astro.config.mjs': Astro,
  'astro.config.ts': Astro,
};

const SPECIAL_FILE_NAMES_LOWER: Readonly<Record<string, IconComp>> = (() => {
  const out: Record<string, IconComp> = {};
  for (const name in SPECIAL_FILE_NAMES) {
    if (Object.prototype.hasOwnProperty.call(SPECIAL_FILE_NAMES, name)) {
      out[name.toLowerCase()] = SPECIAL_FILE_NAMES[name]!;
    }
  }
  return out;
})();

// 扩展名 → icon(case-insensitive,取最后一段)
const EXT_MAP: Readonly<Record<string, IconComp>> = {
  // TypeScript / JavaScript
  ts: TypeScript,
  mts: TypeScript,
  cts: TypeScript,
  tsx: Reactts,
  js: Js,
  mjs: Js,
  cjs: Js,
  jsx: Reactjs,
  // 数据
  json: BracketsYellow,
  jsonc: BracketsYellow,
  yaml: Yaml,
  yml: Yaml,
  toml: BracketsOrange,
  xml: XML,
  csv: Csv,
  // 文档
  md: Markdown,
  mdx: MDX,
  txt: Text,
  log: Text,
  // 网页
  html: CodeOrange,
  htm: CodeOrange,
  css: BracketsBlue,
  scss: Sass,
  sass: Sass,
  styl: Stylus,
  svg: SVG,
  // 图像
  png: Image,
  jpg: Image,
  jpeg: Image,
  gif: Image,
  webp: Image,
  ico: Image,
  bmp: Image,
  // 音视频
  mp3: Audio,
  wav: Audio,
  ogg: Audio,
  flac: Audio,
  m4a: Audio,
  mp4: Video,
  mov: Video,
  webm: Video,
  avi: Video,
  mkv: Video,
  // 文档/包/二进制
  pdf: PDF,
  zip: Zip,
  tar: Zip,
  gz: Zip,
  '7z': Zip,
  rar: Zip,
  exe: Exe,
  app: Exe,
  dmg: Exe,
  // shell
  sh: Shell,
  bash: Shell,
  zsh: Shell,
  fish: Shell,
  // 编程语言
  py: Python,
  rb: Ruby,
  go: Go,
  rs: Rust,
  java: Java,
  kt: Kotlin,
  kts: Kotlin,
  swift: Swift,
  php: PHP,
  cs: Csharp,
  c: CLang,
  h: CLang,
  cpp: Cplus,
  cc: Cplus,
  cxx: Cplus,
  hpp: Cplus,
  lua: Lua,
  vue: Vue,
  svelte: Svelte,
  astro: Astro,
  dart: Dart,
  nix: Nix,
  // 数据科学 / 协议
  ipynb: Notebook,
  proto: Proto,
  graphql: Graphql,
  gql: Graphql,
  prisma: Prisma,
  sql: Database,
};

// 特殊目录名(case-insensitive,key 全小写)
const SPECIAL_DIR_NAMES: Readonly<Record<string, IconComp>> = {
  src: FolderSrc,
  node_modules: FolderNodeModules,
  '.github': FolderGithub,
  '.gitlab': FolderGitlab,
  '.vscode': FolderVSCode,
  assets: FolderAssets,
  public: FolderAssets,
  static: FolderAssets,
  images: FolderImages,
  img: FolderImages,
  fonts: FolderFonts,
  font: FolderFonts,
  hooks: FolderHooks,
  pages: FolderRouter,
  routes: FolderRouter,
  router: FolderRouter,
  utils: FolderUtils,
  util: FolderUtils,
  helpers: FolderHelpers,
  helper: FolderHelpers,
  services: FolderServices,
  service: FolderServices,
  models: FolderModels,
  model: FolderModels,
  types: FolderInterfaces,
  typings: FolderInterfaces,
  interfaces: FolderInterfaces,
  middleware: FolderMiddleware,
  middlewares: FolderMiddleware,
  config: FolderConfig,
  configs: FolderConfig,
  constants: FolderConstants,
  context: FolderContext,
  contexts: FolderContext,
  providers: FolderProviders,
  shared: FolderShared,
  core: FolderCore,
  layout: FolderLayout,
  layouts: FolderLayout,
  modules: FolderModules,
  docs: FolderDocuments,
  doc: FolderDocuments,
  dist: FolderBuild,
  build: FolderBuild,
  out: FolderBuild,
  '.next': FolderBuild,
  '.nuxt': FolderBuild,
};

/**
 * 根据文件名 / 目录名返回对应图标 component。
 *
 * 目录:特殊名(case-insensitive)→ FolderXxx;否则 Folder。
 * 文件:精确名 → ext → fallback Document。`.d.ts` 优先于 `.ts`。
 */
export function getFileIconComponent(
  name: string,
  isDirectory: boolean,
): IconComp {
  if (isDirectory) {
    return SPECIAL_DIR_NAMES[name.toLowerCase()] ?? Folder;
  }
  if (!name) return Document;

  // 1. 精确特殊名(case-sensitive 先)
  const exact = SPECIAL_FILE_NAMES[name];
  if (exact) return exact;

  // 2. case-insensitive 兜底特殊名(README / Readme / readme 都通)
  const lower = name.toLowerCase();
  const specialLower = SPECIAL_FILE_NAMES_LOWER[lower];
  if (specialLower) return specialLower;

  // 3. .d.ts 比通用 .ts 更专精
  if (lower.endsWith('.d.ts')) return Dts;

  // 4. ext(取最后一段,case-insensitive)
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return Document; // 无 ext or 隐藏文件(.bashrc 等)
  const ext = name.slice(idx + 1).toLowerCase();
  return EXT_MAP[ext] ?? Document;
}

/** 直接渲染对应图标。size 默认 16(跟 FileRow ICON_SIZE 一致). */
export function FileIcon({
  name,
  isDirectory,
  size = 16,
}: {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly size?: number;
}) {
  const Icon = getFileIconComponent(name, isDirectory);
  return <Icon width={size} height={size} />;
}
