import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  capJoinedMessages,
  capJoinedMessagesFrom,
} from '../../../electron/shared/cap-joined-messages';
import { formatZodErrorCapped } from '../../../electron/main/lib/format-zod-error';

describe('capJoinedMessages(已物化 string[])', () => {
  it('少量片段 → 直接拼接', () => {
    expect(capJoinedMessages(['a', 'b', 'c'])).toBe('a; b; c');
  });
  it('超 20 条 → 截断 + (+N more)', () => {
    const many = Array.from({ length: 25 }, (_, i) => `e${i}`);
    const msg = capJoinedMessages(many);
    expect(msg).toContain('…(+5 more)'); // 25 - 20
  });

  it('展示项数组预分配,不调用 messages.slice', () => {
    const messages = ['a', 'b', 'c'];
    const sliceSpy = vi.spyOn(messages, 'slice');

    try {
      expect(capJoinedMessages(messages)).toBe('a; b; c');
      expect(sliceSpy).not.toHaveBeenCalled();
    } finally {
      sliceSpy.mockRestore();
    }
  });
});

// 边界(E222,有界迭代族):mapper 变体只对前 20 个元素调 mapper,不全量 .map 物化源数组。
describe('capJoinedMessagesFrom(mapper 变体,E222)', () => {
  it('只对前 MAX_JOINED_ITEMS(20)个元素调 mapper(不全量 map)', () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const mapper = vi.fn((n: number) => `e${n}`);
    const msg = capJoinedMessagesFrom(items, mapper);
    // 中和(改回 items.map(mapper))→ mapper 调 1000 次,该断言失败。
    expect(mapper).toHaveBeenCalledTimes(20);
    expect(msg).toContain('…(+980 more)'); // extra = 1000 - 20,计数精确
  });

  it('少量元素 → 全部 map + 拼接(语义同 capJoinedMessages)', () => {
    const msg = capJoinedMessagesFrom([1, 2, 3], (n) => `e${n}`);
    expect(msg).toBe('e1; e2; e3');
  });

  it('空数组 → 空串', () => {
    expect(capJoinedMessagesFrom([], (n: number) => `${n}`)).toBe('');
  });

  it('展示项数组预分配,不通过 shown.push 扩容', () => {
    const src = readFileSync(
      path.join(process.cwd(), 'electron/shared/cap-joined-messages.ts'),
      'utf-8',
    );
    expect(src).toMatch(/new Array<string>\(limit\)/);
    expect(src).not.toMatch(/shown\.push\(/);
  });
});


// 边界(E223,E222 兄弟):formatZodErrorCapped 用 capJoinedMessagesFrom,不先 error.issues.map 全量物化。
// array schema 校验大量无效元素 → 每元素一 issue → issues 可海量。
describe('formatZodErrorCapped(E223 集成)', () => {
  it('大量 zod issues(array 多无效元素)→ 限条 + (+N more issues)且不抛', () => {
    const schema = z.array(z.string());
    const bad = Array.from({ length: 1000 }, (_, i) => i); // 1000 个非 string → 1000 issues
    const r = schema.safeParse(bad);
    expect(r.success).toBe(false);
    if (r.success) return;
    const msg = formatZodErrorCapped(r.error);
    expect(msg).toContain('more issues'); // 超 20 条 → (+N more issues)
    expect(msg.length).toBeLessThanOrEqual(2100); // 总长受 cap(2048 + 截断标记)
  });
});
