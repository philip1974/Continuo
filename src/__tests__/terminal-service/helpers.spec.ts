import { describe, it, expect, vi } from 'vitest';
import {
  isInPlaceUpdate,
  safeTruncate,
} from '../../../electron/main/services/terminal.service';

describe('safeTruncate', () => {
  it('短于 max → 原样返回', () => {
    expect(safeTruncate('hello', 100)).toBe('hello');
  });

  it('超出 → 截到末尾 max 字节,前置 ANSI reset', () => {
    const data = 'a'.repeat(200);
    const r = safeTruncate(data, 50);
    // \x1b[0m 是 4 字节;然后接 50 个 a(实际可能更短,因为找 ESC 调整)
    expect(r.startsWith('\x1b[0m')).toBe(true);
    expect(r.length).toBeLessThanOrEqual(50 + 4);
  });

  it('截断点附近遇 ESC → 从 ESC 开始(防截断 ANSI 序列)', () => {
    // 构造:大量数据 + ESC + 控制序列
    const head = 'x'.repeat(100);
    const ansi = '\x1b[31m'; // 红色
    const tail = 'final';
    const data = head + ansi + tail;
    const r = safeTruncate(data, 20);
    expect(r.startsWith('\x1b[0m')).toBe(true);
    // 截断点应该在 ansi 起点 ESC 之后(或之前回退)
    // 实际就是说不会切到 \x1b[31m 中间
  });

  // 截断点落在一个 CSI 序列内部(含恰好落在终结符上)时,保留的尾部不能以半截色码开头,
  // 且总字节仍不超过 maxBytes(跳过该序列余下部分,而不是回退到 ESC 多带字节)。
  it.each([9, 10, 11, 12, 13])('截断点落在 CSI 序列内(maxBytes=%i)→ 不留半截色码,总字节 ≤ maxBytes', (max) => {
    const data = 'x'.repeat(100) + '\x1b[31mfinal';
    const r = safeTruncate(data, max);
    expect(r.startsWith('\x1b[0m')).toBe(true);
    const tail = r.slice('\x1b[0m'.length);
    expect(Buffer.byteLength(r, 'utf8')).toBeLessThanOrEqual(Math.max(max, 4));
    // 尾部要么是完整的色码 + 文本,要么是纯文本的后缀;不能是 `[31mfinal` / `1mfinal` / `mfinal` 这类残片
    expect(['\x1b[31mfinal', 'final', 'inal', 'nal', 'al', 'l', '']).toContain(tail);
  });

  // 各种转义序列:把序列放在串中间,让截断点扫过序列的每个位置,保留的尾部都不能是序列残片。
  it.each([
    ['私有模式 CSI', '\x1b[?2004h'],
    ['隐藏光标 CSI', '\x1b[?25l'],
    ['冒号参数 SGR', '\x1b[38:5:196m'],
    ['带中间字节的 CSI', '\x1b[2 q'],
    ['OSC(BEL 结尾)', '\x1b]0;my title\x07'],
    ['OSC(ST 结尾)', '\x1b]0;my title\x1b\\'],
    ['字符集选择', '\x1b(B'],
    ['两字符序列', '\x1bc'],
    ['连续两个 SGR', '\x1b[1m\x1b[31m'],
  ])('%s:截断点落在序列任意位置都不留残片,总字节 ≤ maxBytes', (_label, seq) => {
    const tail = 'TAIL';
    const data = '中'.repeat(40) + seq + tail;
    for (let keep = 0; keep <= seq.length + tail.length + 3; keep += 1) {
      const max = 4 + keep;
      const r = safeTruncate(data, max);
      expect(Buffer.byteLength(r, 'utf8')).toBeLessThanOrEqual(max);
      const kept = r.slice('\x1b[0m'.length);
      // 保留的部分必须是「完整序列…TAIL」的某个后缀,且不从序列中间开始
      const full = seq + tail;
      if (kept.length > full.length) {
        expect(kept.endsWith(full)).toBe(true); // 预算足够,序列整段保留
        continue;
      }
      expect(full.endsWith(kept)).toBe(true);
      const start = full.length - kept.length;
      const boundaries = new Set<number>([0, seq.length, full.length]);
      if (seq === '\x1b[1m\x1b[31m') boundaries.add(4);
      for (let i = seq.length; i <= full.length; i += 1) boundaries.add(i);
      expect(boundaries.has(start)).toBe(true);
    }
  });

  // 畸形输入:序列没有合法终结字节就被别的内容打断。跳过残片时不能把后面的 ESC / 换行 / 半个代理对吃掉。
  it.each([
    ['被新序列打断的 CSI', '\x1b[31', '\x1b[32mZ'],
    ['CSI 后紧跟换行', '\x1b[31', '\nNEXT'],
    ['CSI 后紧跟 emoji', '\x1b[', '😀Z'],
    ['孤立 ESC 后紧跟 emoji', '\x1b', '😀Z'],
  ])('%s:只跳过残片本身,后续内容完整保留', (_label, broken, rest) => {
    const data = 'x'.repeat(100) + broken + rest;
    // 让截断点落在残片内部的每个位置
    for (let inside = 1; inside <= broken.length; inside += 1) {
      const keepBytes = Buffer.byteLength(broken.slice(inside) + rest, 'utf8');
      const r = safeTruncate(data, 4 + keepBytes);
      expect(r).toBe('\x1b[0m' + rest);
    }
  });

  it('串尾未终结的序列被切到 ESC 之后 → 不保留残片', () => {
    const data = 'x'.repeat(100) + '\x1b[3';
    expect(safeTruncate(data, 4 + 2)).toBe('\x1b[0m');
  });

  it('ANSI 截断边界检测走字符扫描,不调用 RegExp.test', () => {
    const testSpy = vi.spyOn(RegExp.prototype, 'test');
    try {
      const data = 'x'.repeat(100) + '\x1b[31mfinal';
      const r = safeTruncate(data, 20);
      expect(r.startsWith('\x1b[0m')).toBe(true);
      expect(testSpy).not.toHaveBeenCalled();
    } finally {
      testSpy.mockRestore();
    }
  });

  it('单字符 max 也能工作(不 crash)', () => {
    const r = safeTruncate('xx'.repeat(50), 1);
    expect(r.startsWith('\x1b[0m')).toBe(true);
  });

  // 边界(E149,E125 同族):按真实 UTF-8 字节截断(非 UTF-16 code unit)。CJK 3 bytes/字。
  it('E149 多字节内容按真实 UTF-8 字节截断(非 code unit)', () => {
    const data = '中'.repeat(200); // 200 code units,600 bytes
    const r = safeTruncate(data, 60); // 保留 ≤60 字节 ≈ 20 个 '中'
    expect(r.startsWith('\x1b[0m')).toBe(true);
    const tail = r.slice('\x1b[0m'.length);
    // 保留内容真实字节 ≤ 60(旧 code-unit 实现会保留 60 个 '中' = 180 字节)
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(60);
    // 未拆坏多字节字符(无替换字符 U+FFFD)
    expect(tail.includes('�')).toBe(false);
    expect(tail.startsWith('中')).toBe(true);
  });

  it('E149 emoji(4 字节)截断保持字符边界,不产生 U+FFFD', () => {
    const data = '😀'.repeat(100); // 100 emoji,400 bytes,200 code units
    const r = safeTruncate(data, 40); // ≤40 字节 = 10 emoji
    const tail = r.slice('\x1b[0m'.length);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(40);
    expect(tail.includes('�')).toBe(false);
  });

  it('E149 byteLength ≤ max 的多字节内容 → 原样返回', () => {
    const data = '中'.repeat(10); // 30 bytes
    expect(safeTruncate(data, 64 * 1024)).toBe(data);
  });

  // 边界(E244):前置 reset(`\x1b[0m`,4 字节)须计入预算 —— 返回值**总**真实字节数 ≤ maxBytes,
  // 而非 maxBytes+4。此前先按 maxBytes 留尾部再无条件前置 reset → 输出超约 4 字节。
  it('E244 返回值总字节(含 reset 前缀)≤ maxBytes(ASCII)', () => {
    const r = safeTruncate('a'.repeat(500), 50);
    expect(r.startsWith('\x1b[0m')).toBe(true);
    expect(Buffer.byteLength(r, 'utf8')).toBeLessThanOrEqual(50); // 不是 54
  });

  it('E244 总字节 ≤ maxBytes(CJK,reset 占预算不拆字符)', () => {
    const r = safeTruncate('中'.repeat(500), 64);
    expect(Buffer.byteLength(r, 'utf8')).toBeLessThanOrEqual(64);
    expect(r.includes('�')).toBe(false);
  });

  it('E244 总字节 ≤ maxBytes(emoji 4 字节)', () => {
    const r = safeTruncate('😀'.repeat(200), 44);
    expect(Buffer.byteLength(r, 'utf8')).toBeLessThanOrEqual(44);
    expect(r.includes('�')).toBe(false);
  });
});

describe('isInPlaceUpdate', () => {
  it('包含光标移动 ESC[A → true', () => {
    expect(isInPlaceUpdate('\x1b[2A')).toBe(true);
  });

  it('包含光标到行首 ESC[H → true', () => {
    expect(isInPlaceUpdate('\x1b[H')).toBe(true);
  });

  it('包含清到行尾 ESC[K → true', () => {
    expect(isInPlaceUpdate('\x1b[K')).toBe(true);
  });

  it('普通文本无 ESC → false', () => {
    expect(isInPlaceUpdate('hello world')).toBe(false);
  });

  // 回归:手写扫描(替代 /\x1b\[\d*[ABCDGHK]/.test)在**第一个** CSI 处就 return,后面的原地更新序列
  // 被漏判 —— 先上色再清行(spinner / 进度条的常见输出)会被当普通输出走更长的节流窗口。
  it('前面有非原地 CSI(如 SGR 颜色)时,后面的原地序列仍命中', () => {
    expect(isInPlaceUpdate('\x1b[31mX\x1b[2K')).toBe(true);
    expect(isInPlaceUpdate('\x1b[1m\x1b[32mdone\x1b[0m\x1b[1A')).toBe(true);
  });

  it('只有非原地 CSI → false;与旧正则在一组样本上逐一等价', () => {
    expect(isInPlaceUpdate('\x1b[31mred\x1b[0m')).toBe(false);
    // 旧实现的正则(用 fromCharCode 拼 ESC,避开 no-control-regex)。
    const re = new RegExp(`${String.fromCharCode(27)}\\[\\d*[ABCDGHK]`);
    for (const sample of [
      '\x1b[31mX\x1b[2K',
      '\x1b[;2K', // 分号参数:旧正则不匹配(\d* 后须紧跟终结符)
      '\x1b[12',
      '\x1b[\x1b[A',
      'a\x1b[0mb\x1b[Gc',
      '\x1b[?25l\x1b[H',
      '\x1b[',
    ]) {
      expect(isInPlaceUpdate(sample)).toBe(re.test(sample));
    }
  });

  it('长文本即便有 ESC → false(避免大段输出被误判)', () => {
    const big = 'x'.repeat(600) + '\x1b[A';
    expect(isInPlaceUpdate(big)).toBe(false);
  });

  it('彩色文本 ESC[31m 不算 in-place(只是属性,不是定位)', () => {
    expect(isInPlaceUpdate('\x1b[31mhello')).toBe(false);
  });

  it('ANSI 原地更新检测走字符扫描,不调用 RegExp.test', () => {
    const testSpy = vi.spyOn(RegExp.prototype, 'test');
    try {
      expect(isInPlaceUpdate('\x1b[12A')).toBe(true);
      expect(isInPlaceUpdate('\x1b[31mhello')).toBe(false);
      expect(testSpy).not.toHaveBeenCalled();
    } finally {
      testSpy.mockRestore();
    }
  });
});
