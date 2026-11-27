// TDD: ts-language-core(语言服务进程里的 TS LanguageService 封装)—— 项目选择(就近 tsconfig / jsconfig / references / 推断项目)、
// 未保存内容、磁盘变化、只读范围。用真实 typescript 在临时工程上跑。BDD: src/__tests__/editor-go-to-definition/
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTsLanguageCore, makeReadGuard, type TsLanguageCore } from '../ts-language/ts-language-core';

let dir: string;
let core: TsLanguageCore;
let clock = 0;

function write(rel: string, text: string): string {
  const p = path.join(dir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

/** text 里第 n 个 needle 的 1 起行列(落在 needle 第 offset 个字符上)。 */
function at(text: string, needle: string, offset = 0, n = 0): { line: number; column: number } {
  let i = -1;
  for (let k = 0; k <= n; k++) i = text.indexOf(needle, i + 1);
  if (i < 0) throw new Error(`needle ${needle} not found`);
  const before = text.slice(0, i + offset);
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
}

function def(file: string, text: string, needle: string, offset = 1, n = 0) {
  const { line, column } = at(text, needle, offset, n);
  return core.definition(file, line, column);
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'ts-core-')));
  clock = 0;
});
afterEach(() => {
  core?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const newCore = () => (core = createTsLanguageCore({ root: dir, now: () => (clock += 5000) }));

describe('tsconfig 项目', () => {
  it('跨文件:import 的符号跳到另一文件的声明(origin = 被解析的标识符区间)', () => {
    write('tsconfig.json', '{"compilerOptions":{"strict":true}}');
    const b = write('b.ts', 'export function helper(): number {\n  return 1;\n}\n');
    const aText = "import { helper } from './b';\nhelper();\n";
    const a = write('a.ts', aText);
    newCore();
    const r = def(a, aText, 'helper();');
    expect(r.definitions).toEqual([
      { path: b, line: 1, column: 17, endLine: 1, endColumn: 23, preview: 'export function helper(): number {' },
    ]);
    expect(r.origin).toEqual({ line: 2, column: 1, endLine: 2, endColumn: 7 });
  });

  it('import 路径字符串 → 目标文件开头', () => {
    write('tsconfig.json', '{}');
    const b = write('b.ts', 'export const x = 1;\n');
    const aText = "import { x } from './b';\nx;\n";
    const a = write('a.ts', aText);
    newCore();
    const r = def(a, aText, "'./b'", 2);
    expect(r.definitions.map((d) => [d.path, d.line, d.column])).toEqual([[b, 1, 1]]);
  });

  it('默认导出 / 重导出(barrel)跳到原始声明', () => {
    write('tsconfig.json', '{}');
    const c = write('c.ts', 'export default function main() {}\nexport const deep = 1;\n');
    write('index.ts', "export { deep } from './c';\n");
    const aText = "import main from './c';\nimport { deep } from './index';\nmain();\ndeep;\n";
    const a = write('a.ts', aText);
    newCore();
    expect(def(a, aText, 'main();').definitions.map((d) => [d.path, d.line, d.column])).toEqual([[c, 1, 25]]);
    expect(def(a, aText, 'deep;').definitions.map((d) => [d.path, d.line, d.column])).toEqual([[c, 2, 14]]);
  });

  it('成员方法;声明合并 → 多个定义', () => {
    write('tsconfig.json', '{}');
    const text =
      'class K {\n  run() { return 1; }\n}\nnew K().run();\ninterface A { x: number }\ninterface A { y: number }\nlet a: A;\n';
    const f = write('m.ts', text);
    newCore();
    expect(def(f, text, 'run();').definitions.map((d) => [d.line, d.column])).toEqual([[2, 3]]);
    const merged = def(f, text, 'A;', 0);
    expect(merged.definitions.map((d) => [d.line, d.preview])).toEqual([
      [5, 'interface A { x: number }'],
      [6, 'interface A { y: number }'],
    ]);
  });

  it('非标识符处 → 无结果', () => {
    write('tsconfig.json', '{}');
    const text = 'const x = 1;\n\n';
    const f = write('e.ts', text);
    newCore();
    expect(core.definition(f, 2, 1)).toEqual({ origin: null, definitions: [] });
  });

  it('未保存内容:按 overlay 定位;移除 overlay 回到磁盘内容', () => {
    write('tsconfig.json', '{}');
    const disk = 'const target = 1;\ntarget;\n';
    const f = write('u.ts', disk);
    newCore();
    expect(def(f, disk, 'target;').definitions[0]!.line).toBe(1);
    const edited = '\n\n\nconst target = 1;\ntarget;\n';
    core.applyChanges([{ path: f, text: edited }]);
    expect(def(f, edited, 'target;').definitions[0]!.line).toBe(4);
    core.applyChanges([{ path: f, text: null }]);
    expect(def(f, disk, 'target;').definitions[0]!.line).toBe(1);
  });

  it('别的文件的未保存修改也生效', () => {
    write('tsconfig.json', '{}');
    const b = write('b.ts', 'export const v = 1;\n');
    const aText = "import { v } from './b';\nv;\n";
    const a = write('a.ts', aText);
    newCore();
    core.applyChanges([{ path: b, text: '// moved\n// down\nexport const v = 1;\n' }]);
    expect(def(a, aText, 'v;', 0).definitions[0]).toMatchObject({ path: b, line: 3 });
  });

  it('磁盘变化由服务自己发现(不需要通知);include 之下新建的文件进项目', () => {
    write('tsconfig.json', '{"include":["src"]}');
    const b = write('src/b.ts', 'export const v = 1;\n');
    const aText = "import { v } from './b';\nv;\n";
    const a = write('src/a.ts', aText);
    newCore();
    expect(def(a, aText, 'v;', 0).definitions[0]!.line).toBe(1);
    writeFileSync(b, '\n\nexport const v = 1; // longer\n');
    expect(def(a, aText, 'v;', 0).definitions[0]!.line).toBe(3);
    const nText = "import { v } from './b';\nv;\n";
    const n = write('src/new.ts', nText);
    expect(def(n, nText, 'v;', 0).definitions[0]).toMatchObject({ path: b, line: 3 });
  });

  it('CRLF 文件:行列不错位', () => {
    write('tsconfig.json', '{}');
    const text = 'const a = 1;\r\nconst b = a;\r\n';
    const f = write('crlf.ts', text);
    newCore();
    expect(core.definition(f, 2, 11).definitions[0]).toMatchObject({ line: 1, column: 7 });
  });
});

describe('项目选择', () => {
  it('多 tsconfig:按就近配置(子包的 paths 生效)', () => {
    write('tsconfig.json', '{}');
    write('pkg/tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["lib/*"]}}}');
    const lib = write('pkg/lib/util.ts', 'export const u = 1;\n');
    const text = "import { u } from '@lib/util';\nu;\n";
    const f = write('pkg/main.ts', text);
    newCore();
    expect(def(f, text, 'u;', 0).definitions[0]).toMatchObject({ path: lib, line: 1 });
  });

  it('solution 式 tsconfig(files: [] + references)→ 按引用的项目', () => {
    write('tsconfig.json', '{"files":[],"references":[{"path":"./tsconfig.app.json"}]}');
    write('tsconfig.app.json', '{"compilerOptions":{"composite":true,"baseUrl":".","paths":{"~/*":["src/*"]}},"include":["src"]}');
    const lib = write('src/lib.ts', 'export const l = 1;\n');
    const text = "import { l } from '~/lib';\nl;\n";
    const f = write('src/app.ts', text);
    newCore();
    expect(def(f, text, 'l;', 0).definitions[0]).toMatchObject({ path: lib });
  });

  it('jsconfig.json:JS 项目', () => {
    write('jsconfig.json', '{}');
    const b = write('b.js', 'export function f() {}\n');
    const text = "import { f } from './b.js';\nf();\n";
    const a = write('a.js', text);
    newCore();
    expect(def(a, text, 'f();', 0).definitions[0]).toMatchObject({ path: b, line: 1, column: 17 });
  });

  it('无配置:推断项目(JS / TS 都可,含 node_modules 假包与 JSX)', () => {
    write('node_modules/fakepkg/package.json', '{"name":"fakepkg","types":"index.d.ts"}');
    const dts = write('node_modules/fakepkg/index.d.ts', 'export declare function fake(): void;\n');
    const text = "import { fake } from 'fakepkg';\nfake();\nconst el = <div />;\n";
    const f = write('x.tsx', text);
    newCore();
    expect(def(f, text, 'fake();', 0).definitions[0]).toMatchObject({ path: dts, line: 1 });
  });

  it('内置 lib(lib.d.ts):跳到 typescript 自带的声明', () => {
    const text = 'const s = "a";\ns.toUpperCase();\n';
    const f = write('lib.ts', text);
    newCore();
    const d = def(f, text, 'toUpperCase').definitions[0]!;
    expect(path.basename(d.path)).toMatch(/^lib\..*\.d\.ts$/);
  });
});

describe('只读范围', () => {
  it('工作区根之内 / 根及其祖先的 node_modules / typescript lib 可读;其余不可读', () => {
    const can = makeReadGuard('/w/repo/pkg', '/opt/ts/lib');
    expect(can('/w/repo/pkg/src/a.ts')).toBe(true);
    expect(can('/w/repo/pkg/node_modules/x/index.d.ts')).toBe(true);
    expect(can('/w/repo/node_modules/x/index.d.ts')).toBe(true);
    expect(can('/node_modules/x/index.d.ts')).toBe(true);
    expect(can('/opt/ts/lib/lib.es5.d.ts')).toBe(true);
    expect(can('/w/repo/other/a.ts')).toBe(false);
    expect(can('/w/other/node_modules/x.d.ts')).toBe(false);
    expect(can('/w/repo/pkg/../secret.ts')).toBe(false);
    expect(can('/etc/passwd')).toBe(false);
  });

  it('import 工作区外的文件 → 当作不存在(定义停在本文件的 import 绑定,不进工作区外)', () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'ts-out-')));
    try {
      writeFileSync(path.join(outside, 'secret.ts'), 'export const s = 1;\n');
      const rel = path.relative(dir, path.join(outside, 'secret')).replace(/\\/g, '/');
      const text = `import { s } from '${rel}';\ns;\n`;
      const f = write('a.ts', text);
      newCore();
      expect(def(f, text, 's;', 0).definitions.map((d) => [d.path, d.line])).toEqual([[f, 1]]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('compilerOptions.plugins 不加载(配置里写了也无影响)', () => {
    write('tsconfig.json', '{"compilerOptions":{"plugins":[{"name":"./evil-plugin"}]}}');
    write('evil-plugin.js', 'throw new Error("plugin must not run")');
    const text = 'const q = 1;\nq;\n';
    const f = write('p.ts', text);
    newCore();
    expect(def(f, text, 'q;', 0).definitions[0]!.line).toBe(1);
  });
});
