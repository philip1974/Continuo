// TDD:查找计数分片扫描(find-match-scan)与整篇一个 cursor 扫出的匹配序列一致 —— 用 @codemirror/search 自己的 cursor 作对照
// 随机 fuzz(小块强制大量块边界),覆盖普通文本(大小写 / 全字 / 转义 \n)、单行正则(^ / $ / 空匹配)、跨行正则与上限。
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { SearchQuery } from '@codemirror/search';
import { MatchScan } from '../../panels/Editor/find-match-scan';

function reference(state: EditorState, q: SearchQuery, limit: number): { ranges: number[]; capped: boolean } {
  const ranges: number[] = [];
  if (!q.valid) return { ranges, capped: false };
  const cursor = q.getCursor(state);
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    if (ranges.length >= limit * 2) return { ranges, capped: true };
    ranges.push(r.value.from, r.value.to);
  }
  return { ranges, capped: false };
}

function scanAll(state: EditorState, q: SearchQuery, limit: number, chunk: number): MatchScan {
  const scan = new MatchScan(state, q, { limit, chunk });
  let steps = 0;
  // 每次 run 只扫一块(deadline 已过)
  while (!scan.run(0, () => 1)) if (++steps > 1e6) throw new Error('scan does not terminate');
  return scan;
}

/** 可复现的伪随机数。 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ALPHABET = ['a', 'b', 'A', 'ab', ' ', '\n', 'x', 'é', 'é', '😀', '.', 'foo'];

function randomDoc(rand: () => number, len: number): string {
  let out = '';
  while (out.length < len) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return out;
}

const LITERALS = ['a', 'ab', 'aa', 'aba', 'A', 'foo', 'o f', 'b\\na', 'é', '😀', 'x.'];
const REGEXPS = ['a+', 'b?a', '^a', 'a$', 'x*', '^', '$', '\\bfoo\\b', 'a\\nb', '\\s+', '[^a]+b', 'o.a'];

describe('MatchScan:分片结果与整篇 cursor 一致', () => {
  it('随机文档 × 普通文本 / 正则 × 选项 × 小块(大量块边界)', () => {
    const rand = rng(20261127);
    for (let round = 0; round < 2000; round++) {
      const doc = randomDoc(rand, Math.floor(rand() * 400));
      const state = EditorState.create({ doc });
      const regexp = rand() < 0.5;
      const pool = regexp ? REGEXPS : LITERALS;
      const q = new SearchQuery({
        search: pool[Math.floor(rand() * pool.length)]!,
        regexp,
        caseSensitive: rand() < 0.5,
        wholeWord: rand() < 0.3,
      });
      // 跨行正则 + 全字匹配:@codemirror/search 的 MultilineRegExpCursor 遇到第一个不满足全字的匹配就停止整篇扫描(其自身缺陷,
      // 计数比实际少);分片扫描每块重新开始,数得更全 —— 不作一致性对照
      if (regexp && q.wholeWord && /\\[sWDnr]|\n|\r|\[\^/.test(q.search)) continue;
      const limit = rand() < 0.2 ? 3 : 1000;
      const chunk = 1 + Math.floor(rand() * 40);
      const expected = reference(state, q, limit);
      const scan = scanAll(state, q, limit, chunk);
      const ctx = JSON.stringify({ doc, search: q.search, regexp, cs: q.caseSensitive, ww: q.wholeWord, chunk, limit });
      expect(scan.ranges, ctx).toEqual(expected.ranges);
      expect(scan.capped, ctx).toBe(expected.capped);
    }
  });

  it('默认块大小:一次 run 在时间上限到达时停下,剩余留到下一次;非法正则 / 空文档直接完成', () => {
    const doc = 'heartbeat ok\n'.repeat(20000) + 'needle\n';
    const state = EditorState.create({ doc });
    const scan = new MatchScan(state, new SearchQuery({ search: 'needle' }));
    expect(scan.run(0, () => 1)).toBe(false);
    expect(scan.ranges).toEqual([]);
    expect(scan.run(Infinity)).toBe(true);
    expect(scan.ranges).toEqual([doc.length - 7, doc.length - 1]);

    expect(new MatchScan(state, new SearchQuery({ search: 'a(', regexp: true })).run(0, () => 1)).toBe(true);
    const empty = new MatchScan(EditorState.create({ doc: '' }), new SearchQuery({ search: '^', regexp: true }));
    expect(empty.run(0, () => 1)).toBe(true);
    expect(empty.ranges).toEqual(reference(EditorState.create({ doc: '' }), new SearchQuery({ search: '^', regexp: true }), 1000).ranges);
  });
});
