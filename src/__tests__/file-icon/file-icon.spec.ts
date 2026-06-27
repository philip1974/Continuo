// BDD: file-icon
// 测 getFileIconComponent 纯函数(name, isDirectory) → IconComponent。
//
// 此 spec 在实装前会 red(module 不存在)。实装目标:
//   src/panels/Explorer/file-icon.tsx 按下面 import 的形态 export。

import { describe, it, expect, vi } from 'vitest';
import {
  Document,
  Folder,
  TypeScript,
  Reactts,
  Js,
  Reactjs,
  Dts,
  Markdown,
  MDX,
  Yaml,
  XML,
  Csv,
  Sass,
  SVG,
  Image,
  Audio,
  Video,
  PDF,
  Zip,
  Shell,
  Python,
  Go,
  Rust,
  License,
  Lock,
  Docker,
  Ignore,
  EditorConfig,
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
  Next,
  Nuxt,
  Astro,
  BracketsYellow,
  BracketsOrange,
  BracketsBlue,
  CodeOrange,
  Database,
  Text,
  Notebook,
  Proto,
  Graphql,
  Prisma,
  FolderSrc,
  FolderNodeModules,
  FolderGithub,
  FolderVSCode,
  FolderAssets,
  FolderImages,
  FolderHooks,
  FolderRouter,
  FolderUtils,
  FolderServices,
  FolderModels,
  FolderInterfaces,
  FolderConfig,
  FolderContext,
  FolderShared,
  FolderCore,
  FolderLayout,
  FolderModules,
  FolderDocuments,
  FolderBuild,
} from '@react-symbols/icons';
import { getFileIconComponent } from '../../panels/Explorer/file-icon';

// ────────────────────────────────────────────────────────────
// 目录
// ────────────────────────────────────────────────────────────

describe('getFileIconComponent · 目录', () => {
  it.each<[string, unknown]>([
    ['src', FolderSrc],
    ['Src', FolderSrc],            // case-insensitive
    ['node_modules', FolderNodeModules],
    ['.github', FolderGithub],
    ['.vscode', FolderVSCode],
    ['assets', FolderAssets],
    ['public', FolderAssets],
    ['static', FolderAssets],
    ['images', FolderImages],
    ['img', FolderImages],
    ['hooks', FolderHooks],
    ['pages', FolderRouter],
    ['routes', FolderRouter],
    ['router', FolderRouter],
    ['utils', FolderUtils],
    ['services', FolderServices],
    ['models', FolderModels],
    ['types', FolderInterfaces],
    ['typings', FolderInterfaces],
    ['interfaces', FolderInterfaces],
    ['config', FolderConfig],
    ['configs', FolderConfig],
    ['context', FolderContext],
    ['contexts', FolderContext],
    ['shared', FolderShared],
    ['core', FolderCore],
    ['layout', FolderLayout],
    ['layouts', FolderLayout],
    ['modules', FolderModules],
    ['docs', FolderDocuments],
    ['doc', FolderDocuments],
    ['dist', FolderBuild],
    ['build', FolderBuild],
    ['out', FolderBuild],
    ['.next', FolderBuild],
  ])('特殊目录 "%s" → 专用 Folder*', (name, expected) => {
    expect(getFileIconComponent(name, true)).toBe(expected);
  });

  it.each(['my-project', 'random-folder', 'foo', 'bar', 'tmp', '__pycache__'])(
    '未命中目录 "%s" → 通用 Folder',
    (name) => {
      expect(getFileIconComponent(name, true)).toBe(Folder);
    },
  );
});

// ────────────────────────────────────────────────────────────
// 文件 — 特殊文件名
// ────────────────────────────────────────────────────────────

describe('getFileIconComponent · 特殊文件名', () => {
  it.each<[string, unknown]>([
    ['package.json', NPM],
    ['package-lock.json', NPM],
    ['pnpm-lock.yaml', PNPM],
    ['pnpm-workspace.yaml', PNPM],
    ['yarn.lock', Yarn],
    ['bun.lockb', Bun],
    ['bun.lock', Bun],
    ['tsconfig.json', Tsconfig],
    ['jsconfig.json', Tsconfig],
    ['vite.config.ts', Vite],
    ['vite.config.js', Vite],
    ['vite.config.mts', Vite],
    ['vitest.config.ts', Vitest],
    ['eslint.config.js', Eslint],
    ['eslint.config.mjs', Eslint],
    ['.eslintrc', Eslint],
    ['.eslintrc.json', Eslint],
    ['.prettierrc', Prettier],
    ['.prettierrc.json', Prettier],
    ['prettier.config.js', Prettier],
    ['tailwind.config.js', Tailwind],
    ['tailwind.config.ts', Tailwind],
    ['biome.json', Biome],
    ['biome.jsonc', Biome],
    ['.gitignore', Ignore],
    ['.gitattributes', Ignore],
    ['.gitmodules', Ignore],
    ['README.md', Markdown],
    ['README', Markdown],
    ['LICENSE', License],
    ['LICENSE.md', License],
    ['LICENSE.txt', License],
    ['Dockerfile', Docker],
    ['docker-compose.yml', Docker],
    ['docker-compose.yaml', Docker],
    ['.dockerignore', Docker],
    ['.env', Lock],
    ['.env.local', Lock],
    ['.env.production', Lock],
    ['.editorconfig', EditorConfig],
    ['next.config.js', Next],
    ['next.config.ts', Next],
    ['nuxt.config.ts', Nuxt],
    ['astro.config.mjs', Astro],
  ])('精确名 "%s" → 专用 icon', (name, expected) => {
    expect(getFileIconComponent(name, false)).toBe(expected);
  });

  it('特殊名大小写不敏感兜底:Readme.md → Markdown', () => {
    expect(getFileIconComponent('Readme.md', false)).toBe(Markdown);
  });

  it('特殊名大小写不敏感兜底不每次 Object.keys 全量枚举', () => {
    const keysSpy = vi.spyOn(Object, 'keys');

    try {
      expect(getFileIconComponent('Readme.md', false)).toBe(Markdown);
      expect(keysSpy.mock.calls.some(([arg]) => arg !== undefined)).toBe(false);
    } finally {
      keysSpy.mockRestore();
    }
  });

  it('特殊名大小写不敏感兜底:license → License', () => {
    expect(getFileIconComponent('license', false)).toBe(License);
  });
});

// ────────────────────────────────────────────────────────────
// 文件 — .d.ts 优先级高于 .ts
// ────────────────────────────────────────────────────────────

describe('getFileIconComponent · .d.ts 特殊', () => {
  it('foo.d.ts → Dts(不是 TypeScript)', () => {
    expect(getFileIconComponent('foo.d.ts', false)).toBe(Dts);
  });

  it('global.d.ts → Dts', () => {
    expect(getFileIconComponent('global.d.ts', false)).toBe(Dts);
  });
});

// ────────────────────────────────────────────────────────────
// 文件 — ext 映射(语言)
// ────────────────────────────────────────────────────────────

describe('getFileIconComponent · ext 编程语言', () => {
  it.each<[string, unknown]>([
    ['app.ts', TypeScript],
    ['mod.mts', TypeScript],
    ['legacy.cts', TypeScript],
    ['App.tsx', Reactts],
    ['util.js', Js],
    ['index.mjs', Js],
    ['legacy.cjs', Js],
    ['Comp.jsx', Reactjs],
    ['main.py', Python],
    ['main.go', Go],
    ['lib.rs', Rust],
    ['build.sh', Shell],
    ['hello.bash', Shell],
  ])('"%s" → %s', (name, expected) => {
    expect(getFileIconComponent(name, false)).toBe(expected);
  });

  it('ext 大小写不敏感:foo.TS → TypeScript', () => {
    expect(getFileIconComponent('foo.TS', false)).toBe(TypeScript);
  });
});

// ────────────────────────────────────────────────────────────
// 文件 — ext 映射(数据/文档/网页)
// ────────────────────────────────────────────────────────────

describe('getFileIconComponent · ext 数据 / 文档 / 网页', () => {
  it.each<[string, unknown]>([
    ['data.json', BracketsYellow],
    ['settings.jsonc', BracketsYellow],
    ['ci.yaml', Yaml],
    ['ci.yml', Yaml],
    ['Cargo.toml', BracketsOrange],
    ['feed.xml', XML],
    ['data.csv', Csv],
    ['notes.md', Markdown],
    ['post.mdx', MDX],
    ['index.html', CodeOrange],
    ['index.htm', CodeOrange],
    ['styles.css', BracketsBlue],
    ['main.scss', Sass],
    ['icon.svg', SVG],
    ['log.txt', Text],
    ['error.log', Text],
    ['schema.sql', Database],
    ['nb.ipynb', Notebook],
    ['user.proto', Proto],
    ['queries.graphql', Graphql],
    ['schema.gql', Graphql],
    ['schema.prisma', Prisma],
  ])('"%s" → 对应数据/文档 icon', (name, expected) => {
    expect(getFileIconComponent(name, false)).toBe(expected);
  });
});

// ────────────────────────────────────────────────────────────
// 文件 — 媒体
// ────────────────────────────────────────────────────────────

describe('getFileIconComponent · ext 媒体', () => {
  it.each(['logo.png', 'photo.jpg', 'pic.jpeg', 'anim.gif', 'thumb.webp', 'fav.ico'])(
    '图像 "%s" → Image',
    (name) => {
      expect(getFileIconComponent(name, false)).toBe(Image);
    },
  );

  it.each(['music.mp3', 'voice.wav', 'sound.ogg'])('音频 "%s" → Audio', (name) => {
    expect(getFileIconComponent(name, false)).toBe(Audio);
  });

  it.each(['movie.mp4', 'clip.mov', 'short.webm'])('视频 "%s" → Video', (name) => {
    expect(getFileIconComponent(name, false)).toBe(Video);
  });

  it.each(['guide.pdf'])('PDF "%s" → PDF', (name) => {
    expect(getFileIconComponent(name, false)).toBe(PDF);
  });

  it.each(['archive.zip', 'src.tar', 'data.gz'])('压缩 "%s" → Zip', (name) => {
    expect(getFileIconComponent(name, false)).toBe(Zip);
  });
});

// ────────────────────────────────────────────────────────────
// fallback
// ────────────────────────────────────────────────────────────

describe('getFileIconComponent · fallback', () => {
  it.each(['unknown.xyz', 'random.foo', 'data.bin'])(
    '未知 ext "%s" → Document',
    (name) => {
      expect(getFileIconComponent(name, false)).toBe(Document);
    },
  );

  it.each(['.bashrc', '.zshrc', '.profile'])(
    '隐藏文件无 ext "%s" → Document',
    (name) => {
      expect(getFileIconComponent(name, false)).toBe(Document);
    },
  );

  it('无 ext 普通文件 "Makefile" → Document', () => {
    expect(getFileIconComponent('Makefile', false)).toBe(Document);
  });

  it('空字符串 → Document(不抛错)', () => {
    expect(getFileIconComponent('', false)).toBe(Document);
  });
});
