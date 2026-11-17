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

// perf E5:EditorPanel 静态依赖 debug 装饰同步;同步模块若静态 import ./debug-decorations(运行时依赖
// @codemirror/view + state),Welcome / 未开代码 tab 时也要下载解析 ~245KB CodeMirror。view 只由已加载
// CodeMirror 的 CodeEditor 注册,故 sync 模块对装饰实现只能 type import + 按需动态 import。
describe('perf E5 — debug 装饰同步不静态引入 CodeMirror', () => {
  it('debug-decoration-sync.ts 不静态 import ./debug-decorations / @codemirror/*', () => {
    const code = src('src/panels/Editor/decorations/debug-decoration-sync.ts');
    const imports = staticValueImports(code);
    expect(imports).toContain('@/stores/editor.store'); // 自检
    expect(imports).not.toContain('./debug-decorations');
    expect(imports.some((s) => s.startsWith('@codemirror/'))).toBe(false);
    expect(code).toContain("import('./debug-decorations')");
  });

  it('EditorPanel.tsx 不静态 import @codemirror/* 或 debug-decorations', () => {
    const imports = staticValueImports(src('src/panels/Editor/EditorPanel.tsx'));
    expect(imports).toContain('./decorations/debug-decoration-sync'); // 自检
    expect(imports.some((s) => s.startsWith('@codemirror/'))).toBe(false);
    expect(imports).not.toContain('./decorations/debug-decorations');
  });
});
