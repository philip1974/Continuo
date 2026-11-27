// @vitest-environment jsdom
// perf E6:@milkdown/crepe 静态 import katex,会把 ~260KB katex 打进 MilkdownEditor chunk。renderer 构建用插件把
// 「来自 @milkdown 的」katex 导入换成空壳;公式渲染改由本项目懒加载的 katex 完成(katex-render,单独 chunk)。
// 本 spec 钉:插件挂在 renderer、只匹配 @milkdown importer;Latex 开启 + configureMarkdownMath 时 Crepe 自带的
// katex 调用点(行内公式 toDOM、latex 代码块预览)都不可达 —— 真实 Crepe 渲染含公式的文档不调用 @milkdown 的 katex。
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

// 本项目的渲染路径换成桩:只数 Crepe 自身对 katex 的调用
vi.mock('../../panels/Editor/katex-render', () => ({
  renderMathInto: (el: HTMLElement, tex: string) => {
    el.textContent = tex;
  },
  renderMathPreview: () => '<div class="continuo-math-block"></div>',
}));

import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { configureMarkdownMath } from '../../panels/Editor/milkdown-math';
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

  it('MilkdownEditor 开启 Latex 并接 configureMarkdownMath(Crepe 的 katex 入口由它覆盖)', () => {
    const editor = src('src/panels/Editor/MilkdownEditor.tsx');
    expect(editor).toMatch(/\[CrepeFeature\.Latex\]:\s*true/);
    expect(editor).toMatch(/configureMarkdownMath\(crepe\)/);
  });

  it('Latex 开启时真实 Crepe 渲染含 $...$ / $$...$$ / ```latex 的文档不调用 @milkdown 的 katex 且原样往返', async () => {
    katexCalls.n = 0;
    const root = document.createElement('div');
    document.body.append(root);
    const markdown = 'inline $a^2$ math\n\n$$\nb\n$$\n\n```latex\nc^2\n```\n';
    const crepe = new Crepe({
      root,
      defaultValue: markdown,
      features: { [CrepeFeature.ImageBlock]: false },
    });
    configureMarkdownMath(crepe);
    try {
      await crepe.create();
      expect(crepe.getMarkdown()).toBe(markdown);
      expect(root.querySelector('[data-type="math_inline"]')?.textContent).toBe('a^2');
      expect(katexCalls.n).toBe(0);
    } finally {
      await crepe.destroy();
      root.remove();
    }
  });
});
