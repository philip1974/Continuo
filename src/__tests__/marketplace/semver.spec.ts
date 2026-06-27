import { describe, it, expect } from 'vitest';
import { isNewerVersion, isValidSemver } from '../../marketplace/semver';

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

  // 边界(E272):prerelease 按 SemVer §11 点分 identifier 比较,非裸字符串序。
  describe('E272 · prerelease 点分 identifier 比较', () => {
    it('数字段按整数比较(beta.10 > beta.2,裸串序会判反)', () => {
      expect(isNewerVersion('1.0.0-beta.10', '1.0.0-beta.2')).toBe(true);
      expect(isNewerVersion('1.0.0-beta.2', '1.0.0-beta.10')).toBe(false);
    });

    it('数字段优先级低于非数字段(alpha.1 < alpha.beta)', () => {
      expect(isNewerVersion('1.0.0-alpha.beta', '1.0.0-alpha.1')).toBe(true);
      expect(isNewerVersion('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(false);
    });

    it('段数多者优先级更高(alpha.1 > alpha)', () => {
      expect(isNewerVersion('1.0.0-alpha.1', '1.0.0-alpha')).toBe(true);
      expect(isNewerVersion('1.0.0-alpha', '1.0.0-alpha.1')).toBe(false);
    });

    it('SemVer §11 经典序列:alpha < alpha.1 < beta < beta.2 < beta.11 < rc.1', () => {
      expect(isNewerVersion('1.0.0-alpha.1', '1.0.0-alpha')).toBe(true);
      expect(isNewerVersion('1.0.0-beta', '1.0.0-alpha.1')).toBe(true);
      expect(isNewerVersion('1.0.0-beta.2', '1.0.0-beta')).toBe(true);
      expect(isNewerVersion('1.0.0-beta.11', '1.0.0-beta.2')).toBe(true);
      expect(isNewerVersion('1.0.0-rc.1', '1.0.0-beta.11')).toBe(true);
    });

    it('非数字段按字典序(rc > beta)', () => {
      expect(isNewerVersion('1.0.0-rc', '1.0.0-beta')).toBe(true);
      expect(isNewerVersion('1.0.0-beta', '1.0.0-rc')).toBe(false);
    });

    it('完全相同 prerelease → false(回归)', () => {
      expect(isNewerVersion('1.0.0-beta.2', '1.0.0-beta.2')).toBe(false);
    });
  });
});

// 边界(E7):数字段超 Number.MAX_SAFE_INTEGER 会变不安全整数/Infinity 仍参与比较 → 畸形版本
// 误判有更新。parseSemver 拒绝不安全整数段(isValidSemver=false),update-check 据此跳过。
describe('isValidSemver (E7)', () => {
  it('合法 X.Y.Z[-pre] → true', () => {
    expect(isValidSemver('1.2.3')).toBe(true);
    expect(isValidSemver('0.0.0')).toBe(true);
    expect(isValidSemver('1.2.3-beta.1')).toBe(true);
    expect(isValidSemver('9007199254740991.0.0')).toBe(true); // MAX_SAFE_INTEGER
  });

  it('超长数字段(不安全整数)→ false', () => {
    expect(isValidSemver('99999999999999999999.0.0')).toBe(false);
    expect(isValidSemver('1.99999999999999999999.0')).toBe(false);
    expect(isValidSemver('1.0.99999999999999999999')).toBe(false);
    expect(isValidSemver('9007199254740992.0.0')).toBe(false); // MAX_SAFE_INTEGER+1
  });

  it('非 X.Y.Z 形态 → false(四段 / 纯文字)', () => {
    expect(isValidSemver('1.2.3.4')).toBe(false);
    expect(isValidSemver('latest')).toBe(false);
    expect(isValidSemver('')).toBe(false);
  });
});

// 边界(E7):两个含不安全整数段的版本不再用 Infinity/不安全整数做数值比较(parseSemver 返 null
// → 字符串 fallback,不再 NaN/Infinity 数值比较)。
describe('isNewerVersion 数字段不安全整数不参与数值比较 (E7)', () => {
  it('不安全整数版本 → parseSemver null → 不会因 Infinity 误判', () => {
    // 旧实现:Number('999…') = Infinity,Infinity > Infinity = false 等不可靠;现走字符串 fallback。
    // 这里只断言不抛 + 返回布尔(行为确定),核心防护在 update-store 的 isValidSemver 跳过。
    expect(typeof isNewerVersion('99999999999999999999.0.0', '1.0.0')).toBe(
      'boolean',
    );
  });
});
