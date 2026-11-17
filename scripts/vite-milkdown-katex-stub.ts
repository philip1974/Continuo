import { resolve } from 'node:path';
import type { Plugin } from 'vite';

// 性能:@milkdown/crepe 的主入口与 feature/toolbar 静态 `import katex from 'katex'`,即使
// CrepeFeature.Latex=false(MilkdownEditor 关闭了公式),MilkdownEditor chunk 仍带 katex@0.16.45
// ~260KB。Latex 关闭时这些调用不可达,这里把**来自 @milkdown 的** katex 导入换成空壳
// (scripts/milkdown-katex-stub.ts)。mermaid 自带的 katex(另一版本、动态加载)不受影响。
// ⚠ 启用 CrepeFeature.Latex 前须移除本插件。见 src/__tests__/perf-audit/README.md E6。

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
