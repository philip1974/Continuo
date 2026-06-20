// 极简 semver 比较(支持 X.Y.Z 三位数字 + 可选 `-prerelease` 后缀)。
// 不引 semver 包(plugin 版本场景非常窄,自家实现 < 40 行,够用)。
//
// prerelease 按 semver 优先级:数字段相等时,**无 prerelease 的版本 > 有 prerelease 的
// 版本**(1.0.0 > 1.0.0-alpha),两者都有 prerelease 则按后缀字符串序。完全无法解析为
// X.Y.Z[-pre] 的(如四段 `1.2.3.4` / 纯文字)退字符串比较。
//
// 修复(第八 session R6):旧正则无尾锚 `$`,`1.2.3-beta` 被解析成 {1,2,3} 丢后缀、与
// `1.2.3` 判等 → 用户在 prerelease 上时收不到升稳定版的更新提示(isNewerVersion('1.2.3',
// '1.2.3-beta') 误返 false)。`1.2.3.4` 四段也被截成 {1,2,3} 误判等。现按真优先级处理。

/** a 比 b 新 → true. 数字段比较,缺位补 0;数字相等时按 prerelease 优先级. */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa && pb) {
    if (pa.major !== pb.major) return pa.major > pb.major;
    if (pa.minor !== pb.minor) return pa.minor > pb.minor;
    if (pa.patch !== pb.patch) return pa.patch > pb.patch;
    // 数字段全等 → prerelease 优先级:无后缀 > 有后缀。
    if (pa.prerelease === pb.prerelease) return false; // 都无 / 完全相同后缀
    if (pa.prerelease === null) return true; // a 稳定,b prerelease → a 更新
    if (pb.prerelease === null) return false; // a prerelease,b 稳定 → a 更旧
    return pa.prerelease > pb.prerelease; // 都 prerelease → 后缀字符串序
  }
  // 任一解析失败(四段 / 纯文字 / 非法)→ 字符串比较 fallback
  return a > b;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  /** `-` 后的 prerelease 串(不含 `-`);无则 null. */
  prerelease: string | null;
}

function parseSemver(s: string): ParsedSemver | null {
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}
