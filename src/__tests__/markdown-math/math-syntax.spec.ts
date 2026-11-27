// @vitest-environment jsdom
// 公式识别规则(Pandoc)与文字里 `$` 的转义:用 MilkdownEditor 同样配置的真实 Crepe 解析器 / 序列化器。见同目录 README.md。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Crepe } from '@milkdown/crepe';
import type { Node as PmNode } from '@milkdown/kit/prose/model';
import { configureMarkdownStyle } from '../../panels/Editor/milkdown-markdown-style';
import {
  canonicalInlineMath,
  configureMarkdownMath,
  escapeDollars,
  inlineMathValueFromRaw,
  unescapeDollars,
} from '../../panels/Editor/milkdown-math';

let crepe: Crepe;
let parse: (md: string) => PmNode;
let serialize: (doc: PmNode) => string;

beforeAll(async () => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  crepe = new Crepe({ root, defaultValue: '', features: { [Crepe.Feature.ImageBlock]: false } });
  configureMarkdownStyle(crepe, '');
  configureMarkdownMath(crepe);
  await crepe.create();
  parse = crepe.editor.ctx.get<(md: string) => PmNode, 'parser'>('parser');
  serialize = crepe.editor.ctx.get<(doc: PmNode) => string, 'serializer'>('serializer');
});

afterAll(async () => {
  await crepe.destroy();
});

function mathValues(md: string): string[] {
  const out: string[] = [];
  parse(md).descendants((n) => {
    if (n.type.name === 'math_inline') out.push(String(n.attrs.value));
  });
  return out;
}

/** 去掉只影响写法的属性(原文 / 围栏信息),比较语义。 */
function semantic(doc: PmNode): unknown {
  const strip = (n: Record<string, unknown>): Record<string, unknown> => {
    const attrs = n.attrs as Record<string, unknown> | undefined;
    const rest = attrs ? Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== 'raw' && k !== 'math')) : undefined;
    const content = n.content as Record<string, unknown>[] | undefined;
    return { ...n, ...(rest ? { attrs: rest } : {}), ...(content ? { content: content.map(strip) } : {}) };
  };
  return strip(doc.toJSON() as Record<string, unknown>);
}

describe('识别规则:remark-math + Pandoc', () => {
  it('单个 `$`:开头后非空白、结尾前非空白 / 反斜杠、结尾后非数字', () => {
    expect(mathValues('a $x$ b\n')).toEqual(['x']);
    expect(mathValues('a$x$b\n')).toEqual(['x']);
    expect(mathValues('$5 and $10\n')).toEqual([]);
    expect(mathValues('range $5-$10\n')).toEqual([]);
    expect(mathValues('a $ x $ b\n')).toEqual([]);
    expect(mathValues('a $x$5\n')).toEqual([]);
    expect(mathValues('a $x\\$ b\n')).toEqual([]);
    expect(mathValues('a \\$x$ b\n')).toEqual([]);
    // 不合规的候选结尾跳过,继续找
    expect(mathValues('$5 and $x$ y\n')).toEqual(['5 and $x']);
    expect(mathValues('$a $ b$\n')).toEqual(['a $ b']);
  });

  it('`$$` 不受 Pandoc 限制;行内代码里的 `$` 不算;不跨段落', () => {
    expect(mathValues('a $$ x $$ b\n')).toEqual(['x']);
    expect(mathValues('a $$x$$ b\n')).toEqual(['x']);
    expect(mathValues('run `$x$` now\n')).toEqual([]);
    expect(mathValues('$x\n\ny$\n')).toEqual([]);
    expect(mathValues('$a\nb$\n')).toEqual(['a\nb']);
  });

  it('不合规的 `$` 是普通字符:其间的强调照常解析(不被当成一段原文吞掉)', () => {
    const doc = parse('$5 *and* $10\n');
    let emphasis = 0;
    doc.descendants((n) => {
      if (n.marks.some((m) => m.type.name === 'emphasis')) emphasis += 1;
    });
    expect(emphasis).toBe(1);
    expect(doc.textContent).toBe('$5 and $10');
  });

  it('不支持 \\(…\\) / \\[…\\](同 VSCode)', () => {
    expect(mathValues('a \\(x\\) b \\[y\\]\n')).toEqual([]);
  });
});

describe('文字里的 `$`', () => {
  it('去掉转义也不改变公式结构 → 不转义(金额原样)', () => {
    for (const md of ['Cost $5 and $10.\n', 'a $ b $ c\n', 'x $5 y\n', 'cost $5, tax $1.5\n', '$x$ and $5\n']) {
      expect(serialize(parse(md))).toBe(md);
    }
  });

  it('去掉转义会新增 / 拆散公式 → 保留转义(含 Milkdown 对「以空白结尾的文字」跳过转义的情形)', () => {
    // 后两例(模糊测试换 Math.imul 后找到):`$_$` 与已有公式 `$a$` 映射后值碰巧相同、文字里的反引号与公式另一侧的配对
    for (const md of ['x \\$5 y $z$\n', 'a \\$x\\$ b\n', 'a\\$ $x$\n', 'x .1  a\\$_$a$ y\n', 'x \\` $`$` y\n']) {
      const out = serialize(parse(md));
      expect(mathValues(out)).toEqual(mathValues(md));
      expect(semantic(parse(out))).toEqual(semantic(parse(md)));
    }
    expect(serialize(parse('x \\$5 y $z$\n'))).toBe('x \\$5 y $z$\n');
  });

  // 轮数 / 种子可用环境变量调大或换(FUZZ_N=20000 FUZZ_SEED=1 pnpm vitest run …)。默认 3000 轮;
  // 重复的段落只测一次,对照组只在发现不一致时才算(绝大多数段落省掉一半解析),全量负载下也远低于超时。
  const FUZZ_N = Number(process.env.FUZZ_N) > 0 ? Number(process.env.FUZZ_N) : 3000;
  const FUZZ_SEED = Number.isFinite(Number(process.env.FUZZ_SEED ?? NaN)) ? Number(process.env.FUZZ_SEED) : 20261127;
  it('随机段落:解析 → 保存 → 再解析语义不变,保存幂等;不含 `$$` / 反斜杠 / 反引号 / 强调符的字节不变', () => {
    const alphabet = ['$', '$', '$', 'a', '1', ' ', '*', '\\', '`', '_', '.'];
    let seed = FUZZ_SEED;
    const rnd = (n: number): number => {
      // Math.imul:普通乘法超出 2^53 精度,低位全是 0,实际只产出约 1600 种段落
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    // 对照:`$` 换成同为标点的 `%` 后同样不稳的(Milkdown 既有的强调 / 反引号序列化问题,如 `*_*_*`、`1*_ .*!`)与公式无关,
    // 跳过(换成字母会改变强调符两侧的「标点」判定,把这类问题误算成 `$` 的)
    const controlStable = (md: string): boolean => {
      const c1 = parse(md.replace(/\$/g, '%'));
      return c1.eq(parse(serialize(c1)));
    };
    const seen = new Set<string>();
    const failures: string[] = [];
    for (let k = 0; k < FUZZ_N; k += 1) {
      let md = 'x ';
      const len = 1 + rnd(12);
      for (let i = 0; i < len; i += 1) md += alphabet[rnd(alphabet.length)];
      md += ' y\n';
      if (seen.has(md)) continue;
      seen.add(md);
      const d1 = parse(md);
      const m1 = serialize(d1);
      const d2 = parse(m1);
      const semanticDiff = JSON.stringify(semantic(d1)) !== JSON.stringify(semantic(d2));
      const notIdempotent = serialize(d2) !== m1;
      if ((semanticDiff || notIdempotent) && controlStable(md)) {
        if (semanticDiff) failures.push(`语义 ${JSON.stringify(md)} → ${JSON.stringify(m1)}`);
        if (notIdempotent) failures.push(`幂等 ${JSON.stringify(md)}`);
      }
      if (!/[\\`*_]|\$\$/.test(md) && m1 !== md) failures.push(`字节 ${JSON.stringify(md)} → ${JSON.stringify(m1)}`);
    }
    expect(failures.slice(0, 10)).toEqual([]);
  }, 30_000);

  it('转义工具:只增删 `\\$`,其它转义原样', () => {
    expect(unescapeDollars('a \\$5 \\\\ \\* b')).toBe('a $5 \\\\ \\* b');
    expect(escapeDollars('a $5 \\$ \\\\$')).toBe('a \\$5 \\$ \\\\\\$');
  });
});

describe('行内公式原文', () => {
  it('原文 ↔ 值(同 mdast-util-math:等长 `$` 串,两端空格各去一个)', () => {
    expect(inlineMathValueFromRaw('$x$')).toBe('x');
    expect(inlineMathValueFromRaw('$$ x $$')).toBe('x');
    expect(inlineMathValueFromRaw('$$  x $$')).toBe(' x');
    expect(inlineMathValueFromRaw('$ $')).toBe(' ');
    expect(inlineMathValueFromRaw('$x')).toBeNull();
  });

  it('规范写法:内容含 `$` 时加长围栏 / 补空格', () => {
    expect(canonicalInlineMath('x')).toBe('$x$');
    expect(canonicalInlineMath('a$b')).toBe('$$a$b$$');
    expect(canonicalInlineMath('$x')).toBe('$$ $x $$');
  });
});
