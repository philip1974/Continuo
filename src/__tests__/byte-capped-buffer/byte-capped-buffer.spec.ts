// 边界(E131,E62/E125 同族):git stderr 等流式输出按真实 UTF-8 字节累积/截断,跨 chunk 多字节
// 字符整体解码不乱码。直接 `acc += String(chunk)` + `acc.length` 会(1)逐 chunk 解码拆坏跨界
// 多字节字符成 U+FFFD;(2)用 UTF-16 code unit 当字节让多字节输出突破字节上限。
import { describe, it, expect } from 'vitest';
import { createByteCappedBuffer } from '../../../electron/main/lib/byte-capped-buffer';

describe('createByteCappedBuffer (E131)', () => {
  it('跨 chunk 边界的多字节字符整体解码不乱码', () => {
    // '中' = E4 B8 AD(3 bytes);拆成 [E4] 和 [B8 AD] 两 chunk。逐 chunk String() 会乱码,
    // 整体 decode 还原成 '中'。
    const full = Buffer.from('中', 'utf8');
    const cap = createByteCappedBuffer(1000);
    cap.push(full.subarray(0, 1));
    cap.push(full.subarray(1));
    expect(cap.text()).toBe('中');
    expect(cap.truncated).toBe(false);
  });

  it('多字节真实字节超上限 → 按字节截断(原始累积 ≤ 上限)+ truncated 标记', () => {
    // maxBytes=10;'中' 3 bytes,5 个 = 15 bytes > 10。原始累积截断到 10 字节(3 个完整 '中'=9 +
    // 第 4 个首字节);decode 末尾半字符 → U+FFFD(再编码会变大,故按「前 3 个完整 + 截断」断言)。
    const cap = createByteCappedBuffer(10);
    cap.push(Buffer.from('中'.repeat(5), 'utf8')); // 15 bytes
    expect(cap.truncated).toBe(true);
    const text = cap.text();
    expect(text.startsWith('中中中')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(4); // 3 完整 + 至多 1 U+FFFD,绝非全部 5 个
  });

  it('ASCII 未超 → 原样;truncated=false', () => {
    const cap = createByteCappedBuffer(100);
    cap.push(Buffer.from('hello ', 'utf8'));
    cap.push(Buffer.from('world', 'utf8'));
    expect(cap.text()).toBe('hello world');
    expect(cap.truncated).toBe(false);
  });

  it('截断后继续 push 被忽略', () => {
    const cap = createByteCappedBuffer(5);
    cap.push(Buffer.from('aaaaaa', 'utf8')); // 6 > 5 → 截断到 5
    expect(cap.truncated).toBe(true);
    cap.push(Buffer.from('bbbb', 'utf8')); // 忽略
    expect(cap.text()).toBe('aaaaa');
  });
});
