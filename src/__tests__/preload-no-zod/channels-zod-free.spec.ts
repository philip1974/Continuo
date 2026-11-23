// 回归守卫:preload 在 Electron sandbox 运行,**无法 require('zod')**。preload 会把
// electron/shared/*-channels.ts 的 channel 常量当**值** import(非 type),若某个 channel
// 文件混入 `import { z } from 'zod'`(如放了 zod 入参 schema),bundler 会把整个模块连同
// zod 拖进 preload 产物 → 运行时 `Unable to load preload script: module not found: zod`,
// 整个 app 白屏(单测/typecheck 抓不到,只有真跑 Electron 才暴露)。
//
// 故:channel 常量文件不得值导入 zod;zod 入参 schema 放到 shared 的独立 *-schema.ts(main 值导入),channel 文件
// 只能 `import type`(编译时擦除,不进 preload 产物)从中推出类型 —— 同 terminal-create.ts 的做法。
// (本守卫源于 S4 marketplace-channels.ts 误把 fetchReviewsInputSchema 放 channels 文件
//  导致的 preload zod 泄漏。)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SHARED_DIR = join(process.cwd(), 'electron/shared');

// 泄漏判定:按语句取出每个模块**值**依赖的模块说明符,再在 electron/shared 内求传递闭包。
// - `import type { … }` / `import type * as …` / `export type { … }` 编译时整句擦除 → 不算依赖;
// - 其它 `import … from` / `export … from` / `import '…'` / 动态 `import('…')` / `require('…')` 都算值依赖
//   (含 `import type from 'zod'` 这种把 type 当默认导入名的写法);
// - 值依赖 zod,或值依赖一个(传递地)值依赖 zod 的 shared 模块 → 该模块会把 zod 带进 preload。
//   不按文件命名约定判断(schema 文件可能叫 *-schemas.ts / plugin-manifest.ts 等)。
const STATEMENT_RE = /(?:^|[;\n])\s*(import|export)\b([^;'"]*?)['"]([^'"]+)['"]/g;
const CALL_RE = /\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g;
function valueSpecifiers(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(STATEMENT_RE)) {
    const [, kw, between, spec] = m;
    if (kw === 'export' && !/\bfrom\s*$/.test(between!)) continue; // export const x = '…' 之类不是再导出
    if (/^\s+type\s*[{*]/.test(between!)) continue; // type-only:整句擦除
    out.push(spec!);
  }
  for (const m of code.matchAll(CALL_RE)) out.push(m[1]!);
  return out;
}

function stripLineComments(src: string): string {
  return src
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** 给定 { 模块名 → 源码 },返回值依赖(含传递)zod 的模块名集合。模块名 = 去扩展名的文件名。 */
function zodTaintedModules(sources: ReadonlyMap<string, string>): Set<string> {
  const deps = new Map<string, string[]>();
  for (const [name, src] of sources) deps.set(name, valueSpecifiers(stripLineComments(src)));
  const tainted = new Set<string>();
  const localName = (spec: string): string | null =>
    spec.startsWith('./') ? spec.slice(2).replace(/\.(js|ts)$/, '') : null;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, specs] of deps) {
      if (tainted.has(name)) continue;
      if (specs.some((sp) => sp === 'zod' || sp.startsWith('zod/') || tainted.has(localName(sp) ?? ''))) {
        tainted.add(name);
        changed = true;
      }
    }
  }
  return tainted;
}

function leaksZod(code: string, shared: ReadonlyMap<string, string> = new Map()): boolean {
  return zodTaintedModules(new Map([...shared, ['__probe__', code]])).has('__probe__');
}

describe('preload sandbox:shared channel 文件不得 import zod', () => {
  it('electron/shared/*-channels.ts 全部 zod-free(含传递依赖,否则拖垮 sandbox preload)', () => {
    const files = readdirSync(SHARED_DIR).filter((f) => f.endsWith('.ts'));
    const sources = new Map(files.map((f) => [f.replace(/\.ts$/, ''), readFileSync(join(SHARED_DIR, f), 'utf-8')]));
    const channelModules = [...sources.keys()].filter((n) => n.endsWith('-channels'));
    expect(channelModules.length).toBeGreaterThan(0); // sanity:确实扫到了文件
    const tainted = zodTaintedModules(sources);
    expect(tainted.size).toBeGreaterThan(0); // sanity:schema 模块确实被识别为值依赖 zod
    expect(channelModules.filter((n) => tainted.has(n)).map((n) => `electron/shared/${n}.ts`)).toEqual([]);
  });

  it('守卫本身:值导入 / 再导出 / 副作用 / 动态导入 zod 与值导入(传递)依赖 zod 的模块判为泄漏,import type 放行', () => {
    const shared = new Map([
      ['a-schemas', "import { z } from 'zod';\nexport const A = z.string();"],
      ['helper', "export { A } from './a-schemas';"],
      ['limits', 'export const MAX = 1;'],
    ]);
    for (const leak of [
      "import { z } from 'zod';",
      "import {\n  z,\n} from 'zod';",
      "export { z } from 'zod';",
      "export * from 'zod';",
      "import type from 'zod';",
      "import type, { z } from 'zod';",
      "import 'zod';",
      "const z = require('zod');",
      "const z = await import('zod');",
      "import { A } from './a-schemas';",
      "import { A } from './a-schemas.js';",
      "export { A } from './a-schemas';",
      "import { A } from './helper'", // 传递 + 无分号
    ]) {
      expect(leaksZod(leak, shared), leak).toBe(true);
    }
    for (const ok of [
      "import type { z } from 'zod';",
      "import type * as zod from 'zod';",
      "import type { A } from './a-schemas';",
      "import { MAX } from './limits'\nimport type { z } from 'zod'", // 无分号:值导入不跨到下一条 type 导入
      "export const NAME = 'zod';",
    ]) {
      expect(leaksZod(ok, shared), ok).toBe(false);
    }
  });
});
