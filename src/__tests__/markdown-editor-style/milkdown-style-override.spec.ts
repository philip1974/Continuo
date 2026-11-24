// Milkdown(Crepe)样式覆写的声明契约。jsdom 不做层叠计算,真实计算样式见 tests/e2e/markdown-editor-style.spec.ts。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/styles/milkdown-font-override.css'), 'utf-8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** 选择器恰为 `selector` 的规则块内容(多个同名块拼接)。 */
function block(selector: string): string {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const sel = m[1]!.trim();
    if (sel === selector) out.push(m[2]!);
  }
  return out.join('\n');
}

describe('Milkdown 样式覆写', () => {
  it('字体与阴影变量接项目 token', () => {
    const root = block('.milkdown');
    expect(root).toMatch(/--crepe-font-default:\s*var\(--wm-font-sans\)/);
    expect(root).toMatch(/--crepe-font-title:\s*var\(--wm-font-sans\)/);
    expect(root).toMatch(/--crepe-font-code:\s*var\(--wm-font-mono\)/);
    expect(root).toMatch(/--crepe-shadow-1:\s*var\(--wm-shadow-popover\)/);
    expect(root).toMatch(/--crepe-shadow-2:\s*var\(--wm-shadow-popover\)/);
  });

  it('字号继承外层容器(editor.fontSize),不被 Crepe 的 --crepe-base-font-size 写死', () => {
    expect(block('.milkdown')).toMatch(/(^|[\s;])font-size:\s*inherit/);
  });

  it('正文内边距随宽度收缩,宽屏封顶原值', () => {
    expect(block('.milkdown .ProseMirror')).toMatch(
      /padding:\s*clamp\(16px,\s*[\d.]+%,\s*60px\)\s+clamp\(16px,\s*[\d.]+%,\s*120px\)/,
    );
  });

  it('表格按内容分配列宽', () => {
    expect(block('.milkdown .ProseMirror table')).toMatch(/table-layout:\s*auto/);
  });
});
