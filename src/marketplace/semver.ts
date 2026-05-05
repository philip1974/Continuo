// 极简 semver 比较(只支持 X.Y.Z 三位数字)。
// 不引 semver 包(plugin 版本场景非常窄,自家实现 < 30 行,够用)。
//
// 不支持 prerelease(-alpha.1 等)— 直接当字符串比;也不强,但实际
// plugin 几乎不会发 prerelease,真发了就 fall back 到字符串顺序。

/** a 比 b 新 → true. 数字段比较,缺位补 0,prerelease 退字符串. */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa && pb) {
    if (pa.major !== pb.major) return pa.major > pb.major;
    if (pa.minor !== pb.minor) return pa.minor > pb.minor;
    if (pa.patch !== pb.patch) return pa.patch > pb.patch;
    return false;
  }
  // 任一解析失败 → 字符串比较 fallback
  return a > b;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(s: string): ParsedSemver | null {
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}
