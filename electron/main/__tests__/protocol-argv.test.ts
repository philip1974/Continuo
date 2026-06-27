import { describe, expect, it } from 'vitest';
import { extractProtocolUrl } from '../protocol-argv';
import { MAX_PROTOCOL_URL_LEN } from '../protocol-dispatch';

describe('extractProtocolUrl — 从 argv 提取 co:// 深链(大小写无关)', () => {
  it('小写 scheme', () => {
    expect(
      extractProtocolUrl(['/path/electron', 'co://command/foo'], 'co'),
    ).toBe('co://command/foo');
  });

  it('大写 / 混合大小写 scheme 也命中(URL scheme 不敏感)', () => {
    expect(extractProtocolUrl(['CO://command/foo'], 'co')).toBe(
      'CO://command/foo',
    );
    expect(extractProtocolUrl(['Co://panel/editor?x=1'], 'co')).toBe(
      'Co://panel/editor?x=1',
    );
  });

  it('带 query 的完整 URL 原样返回', () => {
    expect(
      extractProtocolUrl(['co://command/foo?a=1&b=hi'], 'co'),
    ).toBe('co://command/foo?a=1&b=hi');
  });

  it('无深链 → null(忽略目录/普通参数)', () => {
    expect(extractProtocolUrl(['/usr/bin/app', '/some/dir'], 'co')).toBeNull();
    expect(extractProtocolUrl([], 'co')).toBeNull();
  });

  it('不误命中其它 scheme', () => {
    expect(extractProtocolUrl(['https://x.com', 'file:///a'], 'co')).toBeNull();
  });

  // 边界(E152):超 MAX_PROTOCOL_URL_LEN 的 argv 在 new URL()/toLowerCase 之前即跳过(防超长串
  // 解析/拷贝放大启动 CPU/内存),下游 routeProtocolUrl 本就会拒超长串,故跳过无损。
  it('E152 超 MAX_PROTOCOL_URL_LEN 的超长 argv → 跳过(返回 null,不触发整串解析)', () => {
    const huge = `co://command/${'a'.repeat(MAX_PROTOCOL_URL_LEN)}`;
    expect(huge.length).toBeGreaterThan(MAX_PROTOCOL_URL_LEN);
    // 即便看似合法深链,因超长被跳过 → null(与下游 routeProtocolUrl 拒超长一致)。
    expect(extractProtocolUrl([huge], 'co')).toBeNull();
    // 同批次里长度合规的深链仍能命中(超长项被跳过不影响后续)。
    expect(extractProtocolUrl([huge, 'co://command/ok'], 'co')).toBe(
      'co://command/ok',
    );
  });

  it('E152 恰好等于 MAX_PROTOCOL_URL_LEN 的合规深链仍命中(边界含等号)', () => {
    const scheme = 'co://';
    const exact = scheme + 'a'.repeat(MAX_PROTOCOL_URL_LEN - scheme.length);
    expect(exact.length).toBe(MAX_PROTOCOL_URL_LEN);
    expect(extractProtocolUrl([exact], 'co')).toBe(exact);
  });
});
