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

  it('ignores [[ inside fenced code blocks and inline code', () => {
    expect(isMilkdownUnsafe('# Cargo\n\n```toml\n[[bin]]\nname = "x"\n```\n')).toBe(false);
    expect(isMilkdownUnsafe('~~~bash\nif [[ -f x ]]; then :; fi\n~~~\n')).toBe(false);
    expect(isMilkdownUnsafe('Use `[[ -n "$x" ]]` in bash.\n')).toBe(false);
    expect(isMilkdownUnsafe('Use ``a ` [[b]] `` here.\r\n')).toBe(false);
  });

  it('still flags wiki-links outside code', () => {
    expect(isMilkdownUnsafe('```\ncode\n```\n\nSee [[Note]].\n')).toBe(true);
    expect(isMilkdownUnsafe('`code` and [[Note]]\n')).toBe(true);
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

  it('pathological backtick runs stay linear', () => {
    let line = '[[';
    for (let n = 1; n <= 1500; n += 1) line += '`'.repeat(n) + 'x';
    const t0 = performance.now();
    isMilkdownUnsafe(line + '\n');
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
