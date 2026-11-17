// perf E1:启动路径(main-app → co-app)不得静态引入 CodeMirror 运行时。
// co-app 只在 openFile({line}) 真正跳行时才 `await import('@/panels/Editor/scrollToLine')`,
// 否则 scrollToLine → @codemirror/view 会把整套 CodeMirror 拖进 main-app 启动包,破坏 Editor 懒加载边界。

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf-8');
}

/** 顶层静态值 import 的模块说明符(排除 `import type`)。 */
function staticValueImports(code: string): string[] {
  return [...code.matchAll(/^import\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(
    (m) => m[1] ?? '',
  );
}

describe('perf E1 — co-app 不静态引入 CodeMirror', () => {
  it('co-app.ts 不静态 import scrollToLine / @codemirror/*,跳行处改为动态 import', () => {
    const code = src('src/plugins/co-app.ts');
    const imports = staticValueImports(code);
    expect(imports).toContain('@/stores/editor.store'); // 自检:解析器确实抓到了静态 import
    expect(imports).not.toContain('@/panels/Editor/scrollToLine');
    expect(imports.some((s) => s.startsWith('@codemirror/'))).toBe(false);
    expect(code).toContain("import('@/panels/Editor/scrollToLine')");
  });
});
