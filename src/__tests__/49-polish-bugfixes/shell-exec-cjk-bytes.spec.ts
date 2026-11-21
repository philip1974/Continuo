import { describe, expect, it } from 'vitest';
import { execShell } from '../../../electron/main/services/shell.service';

// P2 回归:execShell 旧实现用 `string.length`(UTF-16 code unit)当字节封顶,且对每个
// data chunk 单独 toString → 多字节 UTF-8 被切到两 chunk 时边界乱码。修复:按 Buffer
// 字节累加封顶,最后 concat 一次性 decode。CJK 重项目尤其重要。
describe('49 · execShell CJK 字节语义 + 无跨 chunk 乱码', () => {
  it('大段 CJK 输出原样回传,无替换字符(�)', async () => {
    const text = '中文测试🚀终端输出'.repeat(500); // 足够大,易被 pipe 切成多 chunk
    const r = await execShell({
      cmd: 'sh',
      args: ['-c', 'cat'],
      input: text,
      maxOutputBytes: 10 * 1024 * 1024,
    });
    expect(r.truncated).toBe(false);
    expect(r.stdout).toBe(text);
    expect(r.stdout).not.toContain('�'); // 无乱码
  });

  it('maxOutputBytes 按字节封顶(非字符数)', async () => {
    // 10 个 CJK 字符 = 30 字节(每字符 3 字节 UTF-8)。cap=15 字节:
    //   - 新(字节)实现:截断,truncated=true,输出 ≤15 字节
    //   - 旧(字符)实现:10 char < 15 → 不截断(bug)
    const text = '一二三四五六七八九十';
    expect(Buffer.byteLength(text, 'utf-8')).toBe(30);
    const r = await execShell({
      cmd: 'sh',
      args: ['-c', 'cat'],
      input: text,
      maxOutputBytes: 15,
    });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout, 'utf-8')).toBeLessThanOrEqual(15);
  });

  it('ASCII 正常路径不受影响', async () => {
    const r = await execShell({ cmd: 'echo', args: ['hello world'] });
    expect(r.stdout.trim()).toBe('hello world');
    expect(r.truncated).toBe(false);
  });
});
