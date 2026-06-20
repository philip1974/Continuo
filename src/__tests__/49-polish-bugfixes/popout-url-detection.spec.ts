import { describe, expect, it } from 'vitest';
import { isPopoutUrl } from '../../../electron/main/popout-url';

// P2-E 主进程 popout 判定收紧:旧实现 `getURL().includes('popout=1')` 用裸子串,
// workspace 路径 / 其它 query 值里恰好含 `popout=1` 的普通主窗会被误判成 popout
// 子窗(setMenu(null) + 禁 Cmd+R)。改为与 renderer src/lib/popout-mode.ts 同语义的
// 精确 query 判定。
describe('49 · isPopoutUrl 精确判定 popout 子窗', () => {
  it('popout=1 query 命中', () => {
    expect(isPopoutUrl('file:///app/index.html?popout=1')).toBe(true);
    expect(isPopoutUrl('file:///app/index.html?windowSeq=0&popout=1')).toBe(
      true,
    );
  });

  it('无 popout query 不命中', () => {
    expect(isPopoutUrl('file:///app/index.html')).toBe(false);
    expect(isPopoutUrl('file:///app/index.html?windowSeq=0')).toBe(false);
  });

  it('popout=0 / 其它值不命中', () => {
    expect(isPopoutUrl('file:///app/index.html?popout=0')).toBe(false);
    expect(isPopoutUrl('file:///app/index.html?popout=true')).toBe(false);
  });

  // 核心回归:workspace 路径里含 `popout=1` 子串,但它不是 query flag,
  // 旧的 includes() 会误判,精确判定必须放过。
  it('workspace 路径含 popout=1 子串不误判(旧 includes bug)', () => {
    const url =
      'file:///Users/me/projects/popout=1-demo/index.html?windowSeq=2';
    expect(url.includes('popout=1')).toBe(true); // 旧实现会误命中
    expect(isPopoutUrl(url)).toBe(false); // 新实现正确放过
  });

  it('query 值里含 popout=1 子串但 flag 不是它,不误判', () => {
    const url = 'file:///app/index.html?last=popout%3D1';
    expect(isPopoutUrl(url)).toBe(false);
  });

  it('畸形 URL 返回 false 不抛', () => {
    expect(isPopoutUrl('not a url')).toBe(false);
    expect(isPopoutUrl('')).toBe(false);
  });
});
