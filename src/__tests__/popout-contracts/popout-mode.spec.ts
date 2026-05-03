import { describe, it, expect } from 'vitest';
import { popoutUrlFor } from '../../lib/popout-mode';

describe('popout 模式 URL 编码', () => {
  it('裸 URL → 加上 popout=1', () => {
    expect(popoutUrlFor('http://localhost:5173/')).toMatch(/[?&]popout=1/);
  });

  it('已有查询的 URL → 追加 popout=1,不破坏其他参数', () => {
    const out = popoutUrlFor('http://localhost:5173/?foo=bar');
    expect(out).toMatch(/[?&]foo=bar/);
    expect(out).toMatch(/[?&]popout=1/);
  });

  it('已带 popout=1 → 幂等(还是 1)', () => {
    const once = popoutUrlFor('http://localhost:5173/?popout=1');
    const twice = popoutUrlFor(once);
    expect(twice).toBe(once);
  });

  it('file:// URL 也能处理', () => {
    expect(popoutUrlFor('file:///path/index.html')).toMatch(/[?&]popout=1/);
  });
});
