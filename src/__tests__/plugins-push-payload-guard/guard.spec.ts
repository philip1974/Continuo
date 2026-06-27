// 边界(E242,E168-E175 IPC push ingress 守卫族):plugins:changed / plugins:protocol-url payload 形态守卫。
// preload onChanged / onProtocolUrl 复用本守卫,畸形 payload warn+drop 不下传脏 id/url。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  isPluginsChangedPayload,
  isProtocolUrlPayload,
  PLUGIN_ID_MAX_LEN,
  PROTOCOL_URL_MAX_LEN,
} from '../../../electron/shared/plugins-channels';

describe('isPluginsChangedPayload (E242)', () => {
  it('合规 { id: 非空 string ≤256 } → true', () => {
    expect(isPluginsChangedPayload({ id: 'com.foo' })).toBe(true);
    expect(isPluginsChangedPayload({ id: 'a'.repeat(PLUGIN_ID_MAX_LEN) })).toBe(true);
  });

  it('null / 非对象 / 数组 → false', () => {
    expect(isPluginsChangedPayload(null)).toBe(false);
    expect(isPluginsChangedPayload(undefined)).toBe(false);
    expect(isPluginsChangedPayload('x')).toBe(false);
    expect(isPluginsChangedPayload(42)).toBe(false);
    expect(isPluginsChangedPayload(['com.foo'])).toBe(false);
  });

  it('id 非字符串 / 空 / 超长 → false', () => {
    expect(isPluginsChangedPayload({ id: 123 })).toBe(false);
    expect(isPluginsChangedPayload({ id: null })).toBe(false);
    expect(isPluginsChangedPayload({})).toBe(false); // 缺 id
    expect(isPluginsChangedPayload({ id: '' })).toBe(false); // 空
    expect(isPluginsChangedPayload({ id: 'a'.repeat(PLUGIN_ID_MAX_LEN + 1) })).toBe(false);
  });
});

describe('isProtocolUrlPayload (E242)', () => {
  it('合规 { url: 非空 string ≤8192 } → true', () => {
    expect(isProtocolUrlPayload({ url: 'co://open?x=1' })).toBe(true);
    expect(isProtocolUrlPayload({ url: 'a'.repeat(PROTOCOL_URL_MAX_LEN) })).toBe(true);
  });

  it('null / 非对象 / 非字符串 / 空 / 超长 → false', () => {
    expect(isProtocolUrlPayload(null)).toBe(false);
    expect(isProtocolUrlPayload('co://x')).toBe(false);
    expect(isProtocolUrlPayload({ url: 123 })).toBe(false);
    expect(isProtocolUrlPayload({})).toBe(false);
    expect(isProtocolUrlPayload({ url: '' })).toBe(false);
    expect(isProtocolUrlPayload({ url: 'a'.repeat(PROTOCOL_URL_MAX_LEN + 1) })).toBe(false);
  });
});

// 接线守卫:preload 的 onChanged / onProtocolUrl 必须实际调用守卫(防漏接/回归)。
describe('E242 preload 接线守卫', () => {
  it('preload/index.ts onChanged/onProtocolUrl 调用守卫', () => {
    const preload = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../electron/preload/index.ts',
      ),
      'utf-8',
    );
    expect(preload).toContain('isPluginsChangedPayload(payload)');
    expect(preload).toContain('isProtocolUrlPayload(payload)');
  });
});
