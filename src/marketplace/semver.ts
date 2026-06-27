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
    // 边界(E272):都 prerelease → 按 SemVer §11 点分 identifier 比较,**非**裸字符串序。裸字符串序
    // 会把 `1.0.0-beta.10` 判为不新于 `1.0.0-beta.2`(逐字符 '1'<'2')→ 更新检查反向/漏报。
    return comparePrerelease(pa.prerelease, pb.prerelease) > 0;
  }
  // 任一解析失败(四段 / 纯文字 / 非法)→ 字符串比较 fallback
  return a > b;
}

/**
 * 边界(E272):SemVer §11 prerelease 比较。返回 >0 表示 a 优先级更高(更新)、<0 更低、0 相等。
 * 规则:按 `.` 分段逐段比 —— 纯数字段按整数比(避免大数 Number 精度,用去前导零后「长度→字典序」);
 * 数字段优先级 < 非数字段;都非数字按 ASCII 字典序;所有公共段相等时段数多者更高
 * (`1.0.0-alpha.1` > `1.0.0-alpha`)。
 */
function comparePrerelease(a: string, b: string): number {
  if (a === b) return 0;
  const as = a.split('.');
  const bs = b.split('.');
  const len = Math.min(as.length, bs.length);
  for (let i = 0; i < len; i += 1) {
    const x = as[i] ?? '';
    const y = bs[i] ?? '';
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      // 纯数字段:去前导零后「长度多者大,等长按字典序」= 任意长度整数精确比较(免 Number 精度问题)。
      const xd = x.replace(/^0+(?=\d)/, '');
      const yd = y.replace(/^0+(?=\d)/, '');
      if (xd.length !== yd.length) return xd.length - yd.length;
      if (xd !== yd) return xd < yd ? -1 : 1;
      continue; // 仅前导零不同 → 视为相等,继续下一段
    }
    if (xNum !== yNum) return xNum ? -1 : 1; // 数字段优先级低于非数字段(alphanumeric)
    return x < y ? -1 : 1; // 都非数字 → ASCII 字典序
  }
  // 所有公共段相等 → 段数多者优先级更高(更长 prerelease 集 > 较短)
  return as.length - bs.length;
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
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  // 边界(E7):`\d+` 允许任意长度数字段,`Number('999…999')` 超 Number.MAX_SAFE_INTEGER 会变不安全
  // 整数甚至 Infinity,仍参与 > 比较 → 畸形远端 manifest.version 被误判「有更新」、甚至把不可表示
  // 版本写入已安装状态。任一段非安全整数即视为不可解析(返 null)。
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null;
  }
  return { major, minor, patch, prerelease: m[4] ?? null };
}

/** 边界(E7):是否合法 X.Y.Z[-pre](数字段为安全整数)。update-check 用它跳过畸形远端版本。 */
export function isValidSemver(s: string): boolean {
  return parseSemver(s) !== null;
}
