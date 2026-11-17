// @vitest-environment jsdom
// perf E6:@milkdown/crepe 静态 import katex,CrepeFeature.Latex=false 时仍把 ~260KB katex 打进
// MilkdownEditor chunk。renderer 构建用插件把「来自 @milkdown 的」katex 导入换成空壳;mermaid 的 katex 不受影响。
// 本 spec 钉:插件挂在 renderer、只匹配 @milkdown importer;Latex 关闭时真实 Crepe 渲染含 $...$ 的文档
// 不调用 katex、不抛错(空壳下同样成立);MilkdownEditor 仍关闭 Latex(启用前须移除空壳)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const katexCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('katex', async () => {
  const stub = (await import('../../../scripts/milkdown-katex-stub')).default;
  return {
    default: {
      render: (...args: unknown[]) => {
        katexCalls.n += 1;
        return (stub.render as (...a: unknown[]) => void)(...args);
      },
      renderToString: (...args: unknown[]) => {
        katexCalls.n += 1;
        return (stub.renderToString as (...a: unknown[]) => string)(...args);
      },
    },
  };
});

import { Crepe, CrepeFeature } from '@milkdown/crepe';
import katexStub from '../../../scripts/milkdown-katex-stub';
import {
  MILKDOWN_KATEX_STUB_PATH,
  isMilkdownKatexImport,
  milkdownKatexStubPlugin,
} from '../../../scripts/vite-milkdown-katex-stub';

function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf-8');
}

describe('perf E6 — @milkdown 的 katex 导入换空壳', () => {
  it('electron.vite.config 的 renderer 挂了 milkdownKatexStubPlugin', () => {
    const config = src('electron.vite.config.ts');
    const renderer = config.slice(config.indexOf('renderer:'));
    expect(renderer).toMatch(/plugins:\s*\[[^\]]*milkdownKatexStubPlugin\(\)/);
  });

  it('只匹配来自 @milkdown 的裸 katex 导入', () => {
    const crepe =
      '/r/node_modules/.pnpm/@milkdown+crepe@7.20.0/node_modules/@milkdown/crepe/lib/esm/index.js';
    const toolbar =
      '/r/node_modules/.pnpm/@milkdown+crepe@7.20.0/node_modules/@milkdown/crepe/lib/esm/feature/toolbar/index.js';
    const mermaid =
      '/r/node_modules/.pnpm/mermaid@11.17.2/node_modules/mermaid/dist/chunks/mermaid.core/chunk-X.mjs';
    expect(isMilkdownKatexImport('katex', crepe)).toBe(true);
    expect(isMilkdownKatexImport('katex', toolbar)).toBe(true);
    expect(isMilkdownKatexImport('katex', 'C:\\r\\node_modules\\@milkdown\\crepe\\lib\\esm\\index.js')).toBe(true);
    expect(isMilkdownKatexImport('katex', mermaid)).toBe(false);
    expect(isMilkdownKatexImport('katex', '/r/src/panels/Editor/MilkdownEditor.tsx')).toBe(false);
    expect(isMilkdownKatexImport('katex', undefined)).toBe(false);
    expect(isMilkdownKatexImport('katex/dist/katex.min.css', crepe)).toBe(false);

    const plugin = milkdownKatexStubPlugin();
    const resolveId = plugin.resolveId as (id: string, importer?: string) => unknown;
    expect(resolveId('katex', crepe)).toBe(MILKDOWN_KATEX_STUB_PATH);
    expect(resolveId('katex', mermaid)).toBeNull();
  });

  it('空壳满足 Crepe 用到的 katex API,调用不抛错', () => {
    expect(() => katexStub.render()).not.toThrow();
    expect(katexStub.renderToString()).toBe('');
  });

  it('MilkdownEditor 仍关闭 Latex(启用前须移除空壳插件)', () => {
    expect(src('src/panels/Editor/MilkdownEditor.tsx')).toMatch(
      /\[CrepeFeature\.Latex\]:\s*false/,
    );
  });

  it('Latex 关闭时真实 Crepe 渲染含 $...$ / $$...$$ 的文档不调用 katex 且原样往返', async () => {
    katexCalls.n = 0;
    const root = document.createElement('div');
    document.body.append(root);
    // 含 ```latex 代码块:Latex 启用时 Crepe 会用 katex 渲染其预览,关闭时走普通代码块
    const markdown = 'inline $a^2$ math\n\n$$\nb\n$$\n\n```latex\nc^2\n```\n';
    const crepe = new Crepe({
      root,
      defaultValue: markdown,
      features: { [CrepeFeature.Latex]: false, [CrepeFeature.ImageBlock]: false },
    });
    try {
      await crepe.create();
      expect(crepe.getMarkdown()).toBe(markdown);
      expect(root.textContent).toContain('$a^2$');
      expect(katexCalls.n).toBe(0);
    } finally {
      await crepe.destroy();
      root.remove();
    }
  });
});
