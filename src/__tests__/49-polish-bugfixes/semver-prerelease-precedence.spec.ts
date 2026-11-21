// P2 版本比较边界回归(第八 session R6):marketplace/semver.ts 的 parseSemver 正则
// `/^(\d+)\.(\d+)\.(\d+)/` 缺尾锚 `$` → `1.2.3-beta` 被解析成 {1,2,3} 丢后缀、与 `1.2.3`
// 判**等**,而非按注释承诺的「prerelease 退字符串/按优先级」。唯一消费点 update-store
// isNewerVersion(remote, local) → 用户在 prerelease 版上时,远程发稳定版 `1.2.3` 与本地
// `1.2.3-beta` 判等 → **永远收不到升稳定版的更新提示**(角标/更新按钮不亮)。四段
// `1.2.3.4` 同样被截成 {1,2,3} 误判等。
//
// 既有 semver.spec.ts:35-40 只断言「prerelease 数字段优先」的两个方向(均保留),漏了
// 「稳定版 > 其 prerelease」这个方向。修复:正则加尾锚 + 解析 prerelease 段,按 semver
// 优先级(数字相等时无后缀 > 有后缀;都有则后缀字符串序;完全无法解析退字符串比较)。
import { describe, it, expect } from 'vitest';
import { isNewerVersion } from '../../marketplace/semver';

describe('49 第八 session · semver prerelease 优先级', () => {
  it('稳定版比其 prerelease 新(修复的核心症状:升稳定版能被检测)', () => {
    expect(isNewerVersion('1.2.3', '1.2.3-beta')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0-alpha')).toBe(true);
  });

  it('prerelease 不比其稳定版新(语义正确,且保留既有 spec 方向)', () => {
    expect(isNewerVersion('1.2.3-beta', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.0.0-alpha', '1.0.0')).toBe(false);
  });

  it('数字段差异优先于 prerelease', () => {
    expect(isNewerVersion('1.0.1-alpha', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.1-beta')).toBe(false);
  });

  it('两个 prerelease 按后缀字符串序', () => {
    expect(isNewerVersion('1.0.0-beta', '1.0.0-alpha')).toBe(true);
    expect(isNewerVersion('1.0.0-alpha', '1.0.0-beta')).toBe(false);
  });

  it('相同 prerelease → 不更新', () => {
    expect(isNewerVersion('1.0.0-rc.1', '1.0.0-rc.1')).toBe(false);
  });

  it('四段版本不再被静默截断判等(走字符串 fallback,1.2.3.4 > 1.2.3)', () => {
    // 修复前:都解析成 {1,2,3} → 判等 → false(漏更新)
    expect(isNewerVersion('1.2.3.4', '1.2.3')).toBe(true);
  });

  it('干净 X.Y.Z 比较不受影响', () => {
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
  });

  it('update-store 场景:本地 prerelease,远程稳定版 → 检测到更新', () => {
    const local = '0.4.0-beta';
    const remote = '0.4.0';
    expect(isNewerVersion(remote, local)).toBe(true);
  });
});
