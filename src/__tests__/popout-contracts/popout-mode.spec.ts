import { afterEach, describe, it, expect, vi } from 'vitest';
import { isPopoutWindow, popoutUrlFor } from '../../lib/popout-mode';

describe('popout 模式 URL 编码', () => {
  it('裸 URL → 加上 popout=1', () => {
    expect(popoutUrlFor('http://localhost:5173/')).toMatch(/[?&]popout=1/);
  });

  // 安全 L1:主进程 windowOpenHandler 只放行 query 恰好为 popout=1 的 URL(见 window-open-policy.spec);
  // popout 子窗只看这个标记,主窗的启动参数(workspace / windowSeq / fresh)一律不带过去。
  it('已有查询的 URL → 丢弃其他参数,只留 popout=1', () => {
    const out = popoutUrlFor('http://localhost:5173/?foo=bar');
    expect(out).toBe('http://localhost:5173/?popout=1');
  });

  it('已带 popout=1 → 幂等(还是 1)', () => {
    const once = popoutUrlFor('http://localhost:5173/?popout=1');
    const twice = popoutUrlFor(once);
    expect(twice).toBe(once);
  });

  it('file:// URL 也能处理', () => {
    expect(popoutUrlFor('file:///path/index.html')).toMatch(/[?&]popout=1/);
  });

  // 边界(E296,A50 反馈契约):popoutUrlFor total(永不抛)—— 不可解析 baseHref 原样返回,不同步抛
  // 绕过调用点 addPopoutGroup().catch→notify.error 反馈。
  it('E296 不可解析 baseHref(非绝对 URL)→ 原样返回,不抛', () => {
    expect(() => popoutUrlFor('not a url ::: %%%')).not.toThrow();
    expect(popoutUrlFor('not a url ::: %%%')).toBe('not a url ::: %%%');
  });
});

// 边界(E195,E193/E194 兄弟入口):popout 的 query 解析复用 safeStartupParams 的启动 query 长度闸。
describe('E195 · popout query 长度上限(同一外部输入族)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('isPopoutWindow:超长 location.search → false(不解析,默认主窗)', () => {
    const huge = `?popout=1&pad=${'a'.repeat(70000)}`; // > MAX_STARTUP_QUERY_LEN
    vi.stubGlobal('window', { location: { search: huge } });
    expect(isPopoutWindow()).toBe(false);
  });

  it('isPopoutWindow:上限内 ?popout=1 → true(回归)', () => {
    vi.stubGlobal('window', { location: { search: '?popout=1' } });
    expect(isPopoutWindow()).toBe(true);
  });

  it('isPopoutWindow:无 window → false', () => {
    vi.stubGlobal('window', undefined);
    expect(isPopoutWindow()).toBe(false);
  });

  it('popoutUrlFor:超长 query → 清空畸形 query 后仍附 popout=1(不携带进子窗)', () => {
    const longQuery = `?pad=${'a'.repeat(70000)}`;
    const out = popoutUrlFor(`http://localhost:5173/${longQuery}`);
    expect(out).toMatch(/[?&]popout=1/);
    expect(out).not.toContain('a'.repeat(300)); // 超长 query 已清空
    expect(out.length).toBeLessThan(200);
  });

  it('popoutUrlFor:上限内的主窗启动 query 也不携带(安全 L1,只留 popout=1)', () => {
    const out = popoutUrlFor(
      'file:///app/out/renderer/index.html?workspace=%2Fx&windowSeq=2&fresh=1&foo=bar',
    );
    expect(out).toBe('file:///app/out/renderer/index.html?popout=1');
  });
});
