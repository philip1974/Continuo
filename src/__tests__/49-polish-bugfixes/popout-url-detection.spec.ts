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

  // 边界(E196,renderer isPopoutWindow E195 主进程对偶):isPopoutUrl 在窗口创建/agent-auth/MCP fallback
  // 等热路径对 webContents.getURL() 反复调用,new URL 前须 typeof + 长度闸,挡畸形超长窗口 URL 反复完整解析。
  describe('E196 · 窗口 URL 长度上限(主进程热路径)', () => {
    it('超长窗口 URL(> MAX_WINDOW_URL_LEN)→ false(不解析)', () => {
      const huge = `file:///app/index.html?popout=1&pad=${'a'.repeat(70000)}`;
      expect(huge.length).toBeGreaterThan(65536);
      expect(isPopoutUrl(huge)).toBe(false);
    });

    it('非字符串 → false 不抛', () => {
      expect(isPopoutUrl(undefined as unknown as string)).toBe(false);
      expect(isPopoutUrl(123 as unknown as string)).toBe(false);
      expect(isPopoutUrl(null as unknown as string)).toBe(false);
    });

    it('上限内正常窗口 URL → 照常精确判定(回归)', () => {
      const longPath = `file:///Users/me/${'sub/'.repeat(1000)}proj/index.html?popout=1`;
      expect(longPath.length).toBeLessThan(65536);
      expect(isPopoutUrl(longPath)).toBe(true);
    });
  });
});
