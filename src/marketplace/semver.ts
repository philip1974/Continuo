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
  let ai = 0;
  let bi = 0;
  for (;;) {
    const aHas = ai < a.length;
    const bHas = bi < b.length;
    if (!aHas || !bHas) return (aHas ? 1 : 0) - (bHas ? 1 : 0);
    const aDot = a.indexOf('.', ai);
    const bDot = b.indexOf('.', bi);
    const ae = aDot < 0 ? a.length : aDot;
    const be = bDot < 0 ? b.length : bDot;
    const cmp = comparePrereleaseSegment(a, ai, ae, b, bi, be);
    if (cmp !== 0) return cmp;
    ai = ae < a.length ? ae + 1 : a.length;
    bi = be < b.length ? be + 1 : b.length;
  }
}

function isDigitsOnly(s: string, start: number, end: number): boolean {
  if (start >= end) return false;
  for (let i = start; i < end; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function trimLeadingZeroes(s: string, start: number, end: number): number {
  while (end - start > 1 && s.charCodeAt(start) === 48) start += 1;
  return start;
}

function compareAsciiSlices(
  a: string,
  as: number,
  ae: number,
  b: string,
  bs: number,
  be: number,
): number {
  const len = Math.min(ae - as, be - bs);
  for (let i = 0; i < len; i += 1) {
    const ac = a.charCodeAt(as + i);
    const bc = b.charCodeAt(bs + i);
    if (ac !== bc) return ac < bc ? -1 : 1;
  }
  return ae - as - (be - bs);
}

function comparePrereleaseSegment(
  a: string,
  as: number,
  ae: number,
  b: string,
  bs: number,
  be: number,
): number {
  const aNum = isDigitsOnly(a, as, ae);
  const bNum = isDigitsOnly(b, bs, be);
  if (aNum && bNum) {
    // 纯数字段:去前导零后「长度多者大,等长按字典序」= 任意长度整数精确比较(免 Number 精度问题)。
    const ad = trimLeadingZeroes(a, as, ae);
    const bd = trimLeadingZeroes(b, bs, be);
    const lenDiff = ae - ad - (be - bd);
    if (lenDiff !== 0) return lenDiff;
    return compareAsciiSlices(a, ad, ae, b, bd, be);
  }
  if (aNum !== bNum) return aNum ? -1 : 1; // 数字段优先级低于非数字段(alphanumeric)
  return compareAsciiSlices(a, as, ae, b, bs, be); // 都非数字 → ASCII 字典序
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  /** `-` 后的 prerelease 串(不含 `-`);无则 null. */
  prerelease: string | null;
}

function parseSemver(s: string): ParsedSemver | null {
  const firstDot = s.indexOf('.');
  if (firstDot <= 0) return null;
  const secondDot = s.indexOf('.', firstDot + 1);
  if (secondDot <= firstDot + 1) return null;
  const dash = s.indexOf('-', secondDot + 1);
  const patchEnd = dash < 0 ? s.length : dash;
  if (patchEnd <= secondDot + 1 || dash === s.length - 1) return null;
  const major = parseSafeIntSegment(s, 0, firstDot);
  const minor = parseSafeIntSegment(s, firstDot + 1, secondDot);
  const patch = parseSafeIntSegment(s, secondDot + 1, patchEnd);
  // 边界(E7):`\d+` 允许任意长度数字段,`Number('999…999')` 超 Number.MAX_SAFE_INTEGER 会变不安全
  // 整数甚至 Infinity,仍参与 > 比较 → 畸形远端 manifest.version 被误判「有更新」、甚至把不可表示
  // 版本写入已安装状态。任一段非安全整数即视为不可解析(返 null)。
  if (major === null || minor === null || patch === null) {
    return null;
  }
  return {
    major,
    minor,
    patch,
    prerelease: dash < 0 ? null : s.slice(dash + 1),
  };
}

function parseSafeIntSegment(
  s: string,
  start: number,
  end: number,
): number | null {
  let n = 0;
  for (let i = start; i < end; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 48 || code > 57) return null;
    n = n * 10 + (code - 48);
    if (!Number.isSafeInteger(n)) return null;
  }
  return n;
}

/** 边界(E7):是否合法 X.Y.Z[-pre](数字段为安全整数)。update-check 用它跳过畸形远端版本。 */
export function isValidSemver(s: string): boolean {
  return parseSemver(s) !== null;
}
