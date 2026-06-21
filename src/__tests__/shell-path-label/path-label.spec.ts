// 可维护性 M11(codex 协作):TitleBar 与 StatusBar 各自复制同一套 chrome 路径展示名
// (`p.match(/[^/\\]+$/)`),收敛到 src/shell/path-label.ts 的 basenameForChrome。本规范锁定
// 其语义(与 Explorer path-utils.basename 不同:这里用正则、不 trim 尾斜杠)。
import { describe, it, expect } from 'vitest';
import { basenameForChrome } from '@/shell/path-label';

describe('shell path-label · basenameForChrome', () => {
  it('取最后一段(/ 与 \\ 都吃)', () => {
    expect(basenameForChrome('/a/b/c')).toBe('c');
    expect(basenameForChrome('C:\\x\\y')).toBe('y');
    expect(basenameForChrome('/a\\b')).toBe('b');
  });

  it('无分隔符 → 返回原串', () => {
    expect(basenameForChrome('foo')).toBe('foo');
    expect(basenameForChrome('')).toBe('');
  });

  it('尾部分隔符**不** trim(无后缀段 → 匹配不到 → 返原串,与 Explorer basename 不同)', () => {
    // /[^/\\]+$/ 在 '/a/b/' 上匹配不到(末尾是分隔符)→ 返回原串。
    expect(basenameForChrome('/a/b/')).toBe('/a/b/');
  });
});
