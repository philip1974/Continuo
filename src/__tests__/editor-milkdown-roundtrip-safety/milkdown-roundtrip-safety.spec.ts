import { describe, expect, it, vi } from 'vitest';
import {
  isMilkdownUnsafe,
  toPreviewMarkdown,
} from '../../panels/Editor/milkdown-roundtrip-safety';

describe('isMilkdownUnsafe', () => {
  it('detects standard YAML frontmatter', () => {
    expect(isMilkdownUnsafe('---\nid: demo\n---\n# Title\n')).toBe(true);
  });

  it('detects BOM-prefixed frontmatter', () => {
    expect(isMilkdownUnsafe('\uFEFF---\nid: demo\n---\n# Title\n')).toBe(true);
  });

  it('detects CRLF frontmatter', () => {
    expect(isMilkdownUnsafe('---\r\nid: demo\r\n---\r\n# Title\r\n')).toBe(true);
  });

  it('detects EOF-terminated frontmatter', () => {
    expect(isMilkdownUnsafe('---\nid: demo\n---')).toBe(true);
  });

  it('detects wiki-links', () => {
    expect(isMilkdownUnsafe('See [[FLOW-orders-balance-checkout-refund]].')).toBe(
      true,
    );
  });

  it('detects hazards with character scanning instead of RegExp.test', () => {
    const testSpy = vi.spyOn(RegExp.prototype, 'test');
    try {
      expect(isMilkdownUnsafe('---\nid: demo\n---\n# Title\n')).toBe(true);
      expect(isMilkdownUnsafe('See [[note]].')).toBe(true);
      expect(testSpy).not.toHaveBeenCalled();
    } finally {
      testSpy.mockRestore();
    }
  });

  it('ignores [[ inside top-level fenced code blocks', () => {
    expect(isMilkdownUnsafe('# Cargo\n\n```toml\n[[bin]]\nname = "x"\n```\n')).toBe(false);
    expect(isMilkdownUnsafe('~~~bash\nif [[ -f x ]]; then :; fi\n~~~\n')).toBe(false);
    expect(isMilkdownUnsafe('\uFEFF```toml\n[[bin]]\n```\n')).toBe(false);
    expect(isMilkdownUnsafe('Intro.\r\n\r\n````md\r\n```\r\n[[x]]\r\n````\r\n')).toBe(false);
  });

  it('still flags wiki-links outside code', () => {
    expect(isMilkdownUnsafe('```\ncode\n```\n\nSee [[Note]].\n')).toBe(true);
    expect(isMilkdownUnsafe('`code` and [[Note]]\n')).toBe(true);
    // 行内代码不剥(同段落可跨行,按行配对会把正文当代码):保守判不安全。
    expect(isMilkdownUnsafe('Use `[[ -n "$x" ]]` in bash.\n')).toBe(true);
    expect(isMilkdownUnsafe('Use `foo\nbar` and [[Note]] with `x`\n')).toBe(true);
    // 缩进闭栏 / 缩进开栏 / HTML 块 / 段落内开栏 / 单独 \r 换行:按 CommonMark [[X]] 是正文。
    expect(isMilkdownUnsafe('```\nfoo\n  ```\n[[X]]\n```\n')).toBe(true);
    expect(isMilkdownUnsafe('  ```\nfoo\n\n```\n[[X]]\n```\n')).toBe(true);
    expect(isMilkdownUnsafe('<div>\n```\n\n[[X]]\n```\n')).toBe(true);
    expect(isMilkdownUnsafe('<!--\n\n```\n-->\n[[X]]\n```\n')).toBe(true);
    expect(isMilkdownUnsafe('`a\r\r[[X]]\r`b`\n')).toBe(true);
    // 文首 BOM 被 CommonMark 丢弃:第 0 行仍是围栏(否则开闭栏错位,把正文当代码)。
    expect(isMilkdownUnsafe('\uFEFF```\n```\n[[X]]\n```\n')).toBe(true);
    // 段落后紧接的第 0 列围栏照样开栏(fuzz 对照 mdast 找到的反例)。
    expect(isMilkdownUnsafe('\rtext\r```js\r\r````\r- [[X]]\r```\t\r````\r')).toBe(true);
    expect(isMilkdownUnsafe('> quote\n```js\n    code\n\n```\n> [[X]]\n```\t\n')).toBe(true);
    // 孤立反引号不得跨段落与后面的反引号配对而把 wiki-link 藏掉。
    expect(isMilkdownUnsafe('a ` stray\n\n[[Note]]\n\nb ` c\n')).toBe(true);
    // 行首 4 空格以上不是围栏。
    expect(isMilkdownUnsafe('    ```\n[[Note]]\n')).toBe(true);
    // 误差只许偏向「不安全」:下列写法里 [[Note]] 都是正文(经 CommonMark 解析核对),不得被当代码藏掉。
    expect(isMilkdownUnsafe('- press ` key\n- link [[Note]]\n- use ` again\n')).toBe(true);
    expect(isMilkdownUnsafe('# Title `x\nsee [[Note]] and ` y\n')).toBe(true);
    expect(isMilkdownUnsafe('Use \\` then [[Real]] then ` end\n')).toBe(true);
    expect(isMilkdownUnsafe('<http://a.com/`>[[Note]] and `x`\n')).toBe(true);
    expect(isMilkdownUnsafe('| `a | [[Note]] | b` |\n')).toBe(true);
    expect(isMilkdownUnsafe('- item\n  ```\n  code\n- next [[Note]]\n')).toBe(true);
    expect(isMilkdownUnsafe('1. item\n   ```js\n   code\n    ```\n\n[[Note]]\n')).toBe(true);
    expect(isMilkdownUnsafe('````\n[[Note]]\n```\n')).toBe(true); // 未闭合:保守
  });

  // 公式:Milkdown 未接 Latex,编辑一次即把 `$x_1$` 写成 `$x\_1$`、`$a\,b$` 写成 `$a,b$`(第四十七轮审计 B3)。
  it('flags inline and block math', () => {
    expect(isMilkdownUnsafe('Energy $x_1 + y_2 = z_{max}$ here.\n')).toBe(true);
    expect(isMilkdownUnsafe('Thin $a\\,b$ space.\n')).toBe(true);
    expect(isMilkdownUnsafe('Set $\\{x\\}$.\n')).toBe(true);
    expect(isMilkdownUnsafe('$$\n\\int_0^1 x\\,dx\n$$\n')).toBe(true);
    expect(isMilkdownUnsafe('Inline $$E = mc^2$$ display.\n')).toBe(true);
    // 块公式里可以有空行、反引号围栏样的行
    expect(isMilkdownUnsafe('$$\na\n\nb\n$$\n')).toBe(true);
    expect(isMilkdownUnsafe('$$\n```\n$$\n\ntext\n```\n')).toBe(true);
    // 行内公式可跨行(同一段落),可在列表 / 引用 / 表格里
    expect(isMilkdownUnsafe('see $a +\nb$ end\n')).toBe(true);
    expect(isMilkdownUnsafe('- item $x_1$\n')).toBe(true);
    expect(isMilkdownUnsafe('> $x^2$\n')).toBe(true);
    expect(isMilkdownUnsafe('| a | $x_1$ |\n| - | - |\n')).toBe(true);
    // 公式先开始:其中的反引号不构成行内代码
    expect(isMilkdownUnsafe('$a `b$ c`\n')).toBe(true);
    // 围栏代码块外的公式照样算
    expect(isMilkdownUnsafe('```\ncode\n```\n\n$x_1$\n')).toBe(true);
  });

  it('does not flag dollars in code, escaped dollars or currency', () => {
    expect(isMilkdownUnsafe('Run `echo $HOME$PATH` now.\n')).toBe(false);
    expect(isMilkdownUnsafe('Use ``a $x$ b`` here.\n')).toBe(false);
    expect(isMilkdownUnsafe('```bash\necho $x_1$\n```\n')).toBe(false);
    expect(isMilkdownUnsafe('```latex\n$$\n\\int_0^1\n$$\n```\n')).toBe(false);
    expect(isMilkdownUnsafe('~~~\n$a$ and $$b$$\n~~~\n')).toBe(false);
    expect(isMilkdownUnsafe('Escaped \\$x_1\\$ text.\n')).toBe(false);
    expect(isMilkdownUnsafe('It costs $5.\n')).toBe(false);
    expect(isMilkdownUnsafe('Between $5 and $10 per seat.\n')).toBe(false);
    expect(isMilkdownUnsafe('Range $5-$10, or $20.\n')).toBe(false);
    expect(isMilkdownUnsafe('Pay $ 5 and $ 6.\n')).toBe(false);
    // 不跨段落配对
    expect(isMilkdownUnsafe('costs $5\n\nnot$ math\n')).toBe(false);
  });

  // 引用式链接定义:Milkdown 解析时把 `[text][ref]` 内联、删掉 `[ref]: …`(schema 没有对应节点)。
  it('flags reference-style link definitions', () => {
    expect(isMilkdownUnsafe('See [the docs][ref].\n\n[ref]: https://example.com/docs "Title"\n')).toBe(true);
    expect(isMilkdownUnsafe('[Other]\n\n   [other]: <https://example.com>\n')).toBe(true);
    expect(isMilkdownUnsafe('> [a]: https://a.com\n')).toBe(true);
    expect(isMilkdownUnsafe('- [a\\]b]: https://a.com\n')).toBe(true);
    expect(isMilkdownUnsafe('```\n[ref]: x\n```\n\n[ref2]: y\n')).toBe(true);
  });

  it('does not flag footnotes, inline links or definitions inside code', () => {
    expect(isMilkdownUnsafe('Text[^1].\n\n[^1]: A footnote.\n')).toBe(false);
    expect(isMilkdownUnsafe('See [docs](https://example.com): ok.\n')).toBe(false);
    expect(isMilkdownUnsafe('```ini\n[section]: x\n```\n')).toBe(false);
    expect(isMilkdownUnsafe('    [x]: y\n')).toBe(false);
  });

  it('math and definition scans stay linear', () => {
    const t0 = performance.now();
    expect(isMilkdownUnsafe('$5 '.repeat(200_000))).toBe(false);
    expect(isMilkdownUnsafe('`'.repeat(3000) + ' $5 '.repeat(50_000))).toBe(false);
    expect(isMilkdownUnsafe('[a]: '.repeat(1) + '\n' + '[x'.repeat(100_000))).toBe(true);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('pathological inputs stay linear', () => {
    let line = '[[';
    for (let n = 1; n <= 1500; n += 1) line += '`'.repeat(n) + 'x';
    const fences = '\n```a'.repeat(100_000) + '\n[[X]]\n';
    const t0 = performance.now();
    isMilkdownUnsafe(line + '\n');
    expect(isMilkdownUnsafe(fences)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('does not flag empty or broken wiki-link delimiters', () => {
    expect(isMilkdownUnsafe('[[]]')).toBe(false);
    expect(isMilkdownUnsafe('See [[note] tail')).toBe(false);
  });

  it('does not flag non-fence frontmatter-like lines', () => {
    expect(isMilkdownUnsafe('---\nid: demo\n--- trailing\n# Title\n')).toBe(false);
  });

  it('does not flag plain prose', () => {
    expect(isMilkdownUnsafe('# Title\nplain related_adr prose\n')).toBe(false);
  });
});

describe('toPreviewMarkdown', () => {
  it('shows frontmatter as a yaml code block', () => {
    expect(toPreviewMarkdown('---\nid: demo\ntags: [a]\n---\n# Title\n')).toBe(
      '```yaml\nid: demo\ntags: [a]\n```\n\n# Title\n',
    );
  });

  it('handles BOM, CRLF and EOF-terminated frontmatter', () => {
    expect(toPreviewMarkdown('\uFEFF---\nid: demo\n---\n# Title\n')).toBe(
      '```yaml\nid: demo\n```\n\n# Title\n',
    );
    expect(toPreviewMarkdown('---\r\nid: demo\r\n---\r\n# Title\r\n')).toBe(
      '```yaml\nid: demo\n```\n\n# Title\r\n',
    );
    expect(toPreviewMarkdown('---\nid: demo\n---')).toBe(
      '```yaml\nid: demo\n```\n\n',
    );
  });

  it('uses a fence longer than any backtick run inside the frontmatter', () => {
    expect(toPreviewMarkdown('---\nnote: "```"\n---\nbody\n')).toBe(
      '````yaml\nnote: "```"\n````\n\nbody\n',
    );
  });

  it('leaves content without frontmatter untouched', () => {
    const plain = '# Title\n\nSee [[note]].\n\n---\n\ntext\n';
    expect(toPreviewMarkdown(plain)).toBe(plain);
    expect(toPreviewMarkdown('---\nid: demo\n--- trailing\n')).toBe(
      '---\nid: demo\n--- trailing\n',
    );
  });
});
