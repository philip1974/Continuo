import { describe, it, expect } from 'vitest';
import { isNewerVersion } from '../../marketplace/semver';

describe('isNewerVersion', () => {
  it('major 升级', () => {
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
  });

  it('minor 升级', () => {
    expect(isNewerVersion('0.2.0', '0.1.99')).toBe(true);
  });

  it('patch 升级', () => {
    expect(isNewerVersion('0.1.2', '0.1.1')).toBe(true);
  });

  it('相同 → false', () => {
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
  });

  it('降级 → false', () => {
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false);
  });

  it('数字不是字典序(0.10.0 > 0.9.0)', () => {
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true);
  });

  it('解析失败 → fallback 字符串比较', () => {
    expect(isNewerVersion('beta', 'alpha')).toBe(true);
    expect(isNewerVersion('alpha', 'beta')).toBe(false);
  });

  it('prerelease 后缀直接被 parse 部分,数字段优先', () => {
    // 1.0.0-alpha 跟 1.0.0:数字段相同 → false
    expect(isNewerVersion('1.0.0-alpha', '1.0.0')).toBe(false);
    // 1.0.1-alpha vs 1.0.0:patch 段大,true
    expect(isNewerVersion('1.0.1-alpha', '1.0.0')).toBe(true);
  });
});
