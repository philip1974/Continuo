// git branch 名 / GitHub repo 路径段形态契约(跨进程单一来源):renderer marketplace entry 校验
//(E104/E107)与 main installFromGit 的 `git clone --branch=<b>` 共用,防两端漂移。
//
// 逐段校验:非空、无前导/尾随 /、无连续 //、每段仅 [A-Za-z0-9._-] 且非 '.'/'..'(charset 已排除
// 控制字符/空白且 URL-safe,可直接拼进 raw.githubusercontent.com 路径)。另拒以 '-' 开头:branch
// 进 git argv,前导 '-' 会被当成选项(argv 注入,如 `-upload-pack=...`)。

export const GIT_BRANCH_MAX = 256;

/** ASCII 字母数字与 `. _ -`(repo 路径段 / branch 段 / review 标题里的 plugin id 片段共用)。 */
export function isSafeRepoPathChar(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 46 ||
    code === 95 ||
    code === 45
  );
}

/** [start,end) 是非空、非 '.'/'..'、仅 isSafeRepoPathChar 的路径段。 */
export function isSafeRepoPathSegment(v: string, start: number, end: number): boolean {
  if (start >= end) return false;
  if (
    v.charCodeAt(start) === 46 &&
    (end - start === 1 || (end - start === 2 && v.charCodeAt(start + 1) === 46))
  )
    return false;
  for (let i = start; i < end; i += 1) {
    if (!isSafeRepoPathChar(v.charCodeAt(i))) return false;
  }
  return true;
}

// 另按 `git check-ref-format` 拒 refname 禁止形态(否则入市场后 clone 必败):任意位置的 `..`、
// 组件以 `.` 开头或以 `.lock` 结尾、整体以 `.` 结尾。`@{`/`@`/空白/控制字符等已被 charset 排除,
// 前导/尾随 `/` 与 `//` 由段级校验拒。
export function isValidGitBranch(b: string): boolean {
  if (b.length === 0 || b.length > GIT_BRANCH_MAX) return false;
  if (b.charCodeAt(0) === 45) return false; // 前导 '-':argv 注入
  if (b.includes('..') || b.endsWith('.')) return false;
  let start = 0;
  for (;;) {
    const slash = b.indexOf('/', start);
    const end = slash < 0 ? b.length : slash;
    if (!isSafeRepoPathSegment(b, start, end)) return false;
    if (b.charCodeAt(start) === 46 || b.slice(start, end).endsWith('.lock')) return false;
    if (slash < 0) return true;
    start = slash + 1;
  }
}
