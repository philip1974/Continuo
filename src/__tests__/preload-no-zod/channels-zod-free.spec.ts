// 回归守卫:preload 在 Electron sandbox 运行,**无法 require('zod')**,而 preload 构建会把 workspace 包
// (如 @continuo-terminal/protocol)和 electron/shared 的模块打进产物。只要 preload 的**值**依赖链上出现 zod,
// 运行时就 `Unable to load preload script: module not found: zod`,整个 app 白屏(单测 / typecheck 抓不到,
// 只有真跑 Electron 才暴露)。
//
// 故:zod 入参 schema 放到 shared 的独立 schema 模块(main 值导入),preload 会值导入的模块(*-channels.ts 等)
// 只能 `import type` 从中推出类型(编译时擦除,不进 preload 产物)—— 同 terminal-create.ts 的做法。
// (本守卫源于 S4 marketplace-channels.ts 误把 fetchReviewsInputSchema 放 channels 文件导致的 preload zod 泄漏。)
//
// 判定:用 TypeScript AST 取每个模块的**值**依赖(import / export … from、副作用导入、动态 import()、require();
// `import type` / `export type` / 全部成员都是 `type` 的导入编译时擦除,不算),从 electron/preload 的每个入口出发
// 沿相对路径求闭包(不限目录、不看文件命名)。闭包里出现 `zod`,或出现 package.json 声明依赖 zod 的包 → 泄漏。
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const PRELOAD_DIR = join(ROOT, 'electron/preload');

function valueSpecifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            named !== undefined &&
            ts.isNamedImports(named) &&
            named.elements.length > 0 &&
            named.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const typeOnly =
        node.isTypeOnly ||
        (clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const [arg] = node.arguments;
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isImport || isRequire) && arg && ts.isStringLiteralLike(arg)) out.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function resolveLocal(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec.replace(/\.(js|ts)$/, ''));
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

function packageDependsOnZod(name: string, root: string): boolean {
  if (name === 'zod') return true;
  const pj = join(root, 'node_modules', name, 'package.json');
  if (!existsSync(pj)) return false;
  const json = JSON.parse(readFileSync(pj, 'utf-8')) as Record<string, Record<string, string> | undefined>;
  return ['dependencies', 'peerDependencies'].some((k) => json[k]?.zod !== undefined);
}

/** 从 entries 出发求值依赖闭包,返回每条泄漏的依赖链(空 = 无泄漏)。 */
function zodLeakChains(entries: readonly string[], root: string): string[] {
  const leaks: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: readonly string[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of valueSpecifiers(file)) {
      const here = [...chain, file.replace(`${root}/`, '')];
      if (spec.startsWith('.')) {
        const next = resolveLocal(file, spec);
        if (next) walk(next, here);
      } else if (packageDependsOnZod(packageName(spec), root)) {
        leaks.push([...here, spec].join(' → '));
      }
    }
  };
  for (const e of entries) walk(e, []);
  return leaks;
}

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? listTs(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : [],
  );
}

describe('preload sandbox:值依赖闭包里不得出现 zod', () => {
  it('electron/preload 全部入口的值依赖闭包(含 electron/shared、子目录、workspace 包)不含 zod', () => {
    const entries = listTs(PRELOAD_DIR);
    expect(entries.length).toBeGreaterThan(0); // sanity:确实扫到了文件
    expect(zodLeakChains(entries, ROOT)).toEqual([]);
  });

  it('sanity:shared 的 schema 模块确实被识别为依赖 zod(守卫没有空转)', () => {
    expect(zodLeakChains([join(ROOT, 'electron/shared/plugin-mcp-schemas.ts')], ROOT)).not.toEqual([]);
    expect(zodLeakChains([join(ROOT, 'electron/shared/mcp-terminal-schemas.ts')], ROOT)).not.toEqual([]);
  });

  it('守卫本身:各种值依赖写法判为泄漏,type-only 放行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'preload-no-zod-'));
    try {
      mkdirSync(join(dir, 'node_modules/@x/proto'), { recursive: true });
      writeFileSync(join(dir, 'node_modules/@x/proto/package.json'), JSON.stringify({ dependencies: { zod: '4' } }));
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub/a-schemas.ts'), "import { z } from 'zod';\nexport const A = z.string();\n");
      writeFileSync(join(dir, 'helper.ts'), "export { A } from './sub/a-schemas'\n");
      writeFileSync(join(dir, 'limits.ts'), "export const MAX = 1; export const U = 'http://x'\n");
      const probe = (code: string): string[] => {
        writeFileSync(join(dir, 'probe.ts'), code);
        return zodLeakChains([join(dir, 'probe.ts')], dir);
      };
      for (const leak of [
        "import { z } from 'zod';",
        "import {\n  z,\n} from 'zod';",
        "export { z } from 'zod';",
        "export * from 'zod';",
        "import type, { z } from 'zod';",
        "import { type T, z } from 'zod';",
        "import { /* it's */ z } from 'zod';",
        "import 'zod';",
        "const z = require('zod');",
        "const z = await import('zod');",
        'const z = await import(`zod`);',
        "import { A } from './sub/a-schemas.js';",
        "export { A } from './sub/a-schemas';",
        "import { A } from './helper'",
        "export type { Foo }\nimport { z } from 'zod'",
        "export const U = 'http://x'; export { A } from './sub/a-schemas';",
        "export * from '@x/proto';",
      ]) {
        expect(probe(leak), leak).not.toEqual([]);
      }
      for (const ok of [
        "import type { z } from 'zod';",
        "import type * as zod from 'zod';",
        "import { type z } from 'zod';",
        "export type { A } from './sub/a-schemas';",
        "import type { A } from './helper';",
        "import { MAX } from './limits'\nimport type { z } from 'zod'",
        "export const NAME = 'zod';",
        "type Z = typeof import('zod');",
        "import { ipcRenderer } from 'electron';",
      ]) {
        expect(probe(ok), ok).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
