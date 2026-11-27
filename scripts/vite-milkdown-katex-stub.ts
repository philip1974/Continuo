import { resolve } from 'node:path';
import type { Plugin } from 'vite';

// 性能:@milkdown/crepe 的主入口与 feature/toolbar 静态 `import katex from 'katex'`,会让 MilkdownEditor chunk
// 带上 katex ~260KB。Crepe 的这些调用点都被 src/panels/Editor/milkdown-math.ts 覆盖(公式改由懒加载的
// katex-render 渲染,katex 单独成 chunk),这里把**来自 @milkdown 的** katex 导入换成空壳
// (scripts/milkdown-katex-stub.ts)。本项目自己的 `import('katex')` 与 mermaid 自带的 katex 不受影响。
// ⚠ 去掉 configureMarkdownMath 前须先移除本插件。见 src/__tests__/perf-audit/README.md E6。

export const MILKDOWN_KATEX_STUB_PATH = resolve(__dirname, 'milkdown-katex-stub.ts');

const MILKDOWN_IMPORTER = /[\\/]node_modules[\\/]@milkdown[\\/]/;

export function isMilkdownKatexImport(id: string, importer: string | undefined): boolean {
  return id === 'katex' && importer !== undefined && MILKDOWN_IMPORTER.test(importer);
}

export function milkdownKatexStubPlugin(): Plugin {
  return {
    name: 'continuo:milkdown-katex-stub',
    enforce: 'pre',
    resolveId(id, importer) {
      return isMilkdownKatexImport(id, importer) ? MILKDOWN_KATEX_STUB_PATH : null;
    },
  };
}
