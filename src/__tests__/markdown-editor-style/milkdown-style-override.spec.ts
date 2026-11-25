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

  it('Crepe 内部按 --crepe-base-font-size 算字号的部件(代码块占位层等)也跟随外层容器给的字号', () => {
    expect(block('.milkdown')).toMatch(/--crepe-base-font-size:\s*inherit/);
  });

  it('正文内边距随宽度收缩,宽屏封顶原值;左侧下限容纳块手柄(2×32px 按钮 + 2px 间距 + 16px 偏移 = 82px)', () => {
    const m = /padding:\s*clamp\(16px,\s*[\d.]+%,\s*60px\)\s+clamp\(16px,\s*[\d.]+%,\s*120px\)\s+clamp\(16px,\s*[\d.]+%,\s*60px\)\s+clamp\((\d+)px,\s*[\d.]+%,\s*120px\)/.exec(
      block('.milkdown .ProseMirror'),
    );
    expect(m, '缺少四值 padding(上 右 下 左)').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(82);
  });

  it('只读(Preview,无块手柄)左内边距不必为手柄留位', () => {
    expect(block(".milkdown .ProseMirror[contenteditable='false']")).toMatch(
      /padding-left:\s*clamp\(16px,\s*[\d.]+%,\s*120px\)/,
    );
  });

  it('表格按内容分配列宽', () => {
    expect(block('.milkdown .ProseMirror table')).toMatch(/table-layout:\s*auto/);
  });

  // Crepe 列表序号 / 圆点盒固定 32px(= 16px 段落的 1.5 行高 + 上下 4px),其它字号下与首行文字错位(13px 时低约 2px)。
  it('列表序号盒高度与行高跟随段落(1.5em 行高 + 上下 4px),任意字号下与首行文字对齐', () => {
    const wrapper = block('.milkdown .milkdown-list-item-block li .label-wrapper');
    const label = block('.milkdown .milkdown-list-item-block li .label-wrapper .label');
    expect(wrapper).toMatch(/height:\s*calc\(1\.5em \+ 8px\)/);
    expect(label).toMatch(/height:\s*calc\(1\.5em \+ 8px\)/);
    expect(label).toMatch(/line-height:\s*1\.5(;|\s|$)/);
  });

  // WCAG 2.4.7:Crepe 代码块工具条(语言按钮 / 复制)只在 :hover 时 opacity 1,Tab 到时看不见也没有焦点轮廓。
  describe('代码块工具条键盘可见(WCAG 2.4.7)', () => {
    /** 选择器列表含 `selector` 的所有规则块内容。 */
    function blocksWith(selector: string): string {
      const out: string[] = [];
      const re = /([^{}]+)\{([^{}]*)\}/g;
      for (let m = re.exec(css); m; m = re.exec(css)) {
        if (m[1]!.split(',').map((x) => x.trim()).includes(selector)) out.push(m[2]!);
      }
      return out.join('\n');
    }

    it('只读预览不显示语言按钮(只读下不能改语言,Tab 不再停在看不见的按钮上)', () => {
      expect(
        blocksWith(".milkdown .ProseMirror[contenteditable='false'] .milkdown-code-block .tools .language-button"),
      ).toMatch(/display:\s*none/);
    });

    it('代码块内有焦点或按钮键盘聚焦时工具条按钮显示(opacity 1)', () => {
      for (const sel of [
        '.milkdown .milkdown-code-block:focus-within .tools .language-button',
        '.milkdown .milkdown-code-block:focus-within .tools .tools-button-group > button',
        '.milkdown .milkdown-code-block .tools .language-button:focus-visible',
        '.milkdown .milkdown-code-block .tools .tools-button-group > button:focus-visible',
      ]) {
        expect(blocksWith(sel), sel).toMatch(/opacity:\s*1/);
      }
    });

    it('按钮键盘聚焦有焦点环(focus-ring token)', () => {
      for (const sel of [
        '.milkdown .milkdown-code-block .tools .language-button:focus-visible',
        '.milkdown .milkdown-code-block .tools .tools-button-group > button:focus-visible',
      ]) {
        expect(blocksWith(sel), sel).toMatch(/outline:\s*1px solid var\(--md-focus-ring\)/);
      }
    });
  });
});
