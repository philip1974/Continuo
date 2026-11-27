// 跨平台路径小工具(renderer 没有 node:path)。
//
// renderer 多处用 `${dir}/${name}` 拼路径、用 `root + '/'` 前缀剥离,在 Windows 上
// (路径用 `\`)会产生混合分隔符或前缀失配,导致 tab id / watch 广播 / 相对路径显示
// 不一致(跨平台审计 P1/P2)。这里统一两个分隔符无关的纯函数。

import { lowerIfNeeded } from '../../electron/shared/lower-if-needed';

/**
 * 拼接目录与名字,沿用目录的「活动分隔符」(最后出现的 `/` 或 `\`;盘符根 `C:` 用 `\`;
 * 都没有则默认 `/`)。先去掉 dir 尾部多余分隔符,避免 `a//b`。
 */
export function joinPath(dir: string, name: string): string {
  const d = trimTrailingSeparators(dir);
  const useBackslash =
    d.lastIndexOf('\\') > d.lastIndexOf('/') || isBareWindowsDrive(d);
  return `${d}${useBackslash ? '\\' : '/'}${name}`;
}

/**
 * 把绝对路径 `p` 相对 `root` 剥成相对路径:确认 `p` 在 root 内后截掉 root 长度、去前导分隔符。
 * 分隔符无关(root 带不带尾部分隔符都行);`p` 不在 root 下时原样返回。
 * 跨平台审计 P2:用 isSameOrInsidePath 做归属判定 —— 修两处缺陷 →(a)裸
 * `startsWith(root)` 缺路径边界:`/root` 会错剥 `/rooted/a` 成 `ed/a`;(b)Windows 大小写
 * 敏感:`c:\repo` 剥 `C:\Repo\src\a.ts` 失配 → Copy Relative Path 出绝对路径。切片仍按原
 * `root.length`(大小写折叠不改长度)。
 */
export function stripRootPrefix(root: string, p: string): string {
  if (!isSameOrInsidePath(root, p)) return p;
  return trimLeadingSeparators(p.slice(root.length));
}

/** 当前 renderer 是否跑在 Windows(navigator.platform 以 win 开头,大小写不敏感)。 */
export function isWindowsRuntime(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform ?? '';
  return (
    platform.length >= 3 &&
    (platform.charCodeAt(0) | 32) === 119 &&
    (platform.charCodeAt(1) | 32) === 105 &&
    (platform.charCodeAt(2) | 32) === 110
  );
}

/** 当前 renderer 是否跑在 macOS(navigator.platform 以 mac 开头,大小写不敏感)。 */
export function isMacRuntime(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (navigator.platform ?? '').slice(0, 3).toLowerCase() === 'mac';
}

// 路径字符级 helper 的 renderer 单一来源(Explorer path-utils / Editor editor-path-utils /
// link-resolve 共用;此前各自逐字复制)。
export function isPathSeparatorCode(code: number): boolean {
  return code === 47 || code === 92;
}

export function isAsciiAlphaCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

export function isBareWindowsDrive(value: string): boolean {
  return (
    value.length === 2 &&
    isAsciiAlphaCode(value.charCodeAt(0)) &&
    value.charCodeAt(1) === 58
  );
}

/**
 * 去尾部分隔符但保留根:`/a/b/` → `/a/b`;`/` → `/`;`C:\\` → `C:\\`;`C:\\x\\` → `C:\\x`。工作区根的规范形 ——
 * 子项路径(main `path.join`)不带尾分隔符,根若带(shell Tab 补全出的 `~/proj/`)则 `dirname(child) === root` 等字符串比较
 * 全部失配(拖到空白处误判可移动 → 文件被改名成 `x copy`;外部变更同步对不上根;最近列表重复)。
 */
export function trimTrailingSeparatorsKeepRoot(value: string): string {
  const trimmed = trimTrailingSeparators(value);
  if (trimmed === value) return value;
  if (trimmed === '') return value.slice(0, 1);
  if (isBareWindowsDrive(trimmed)) return value.slice(0, 3);
  return trimmed;
}

export function trimTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && isPathSeparatorCode(value.charCodeAt(end - 1))) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function trimLeadingSeparators(value: string): string {
  let start = 0;
  while (start < value.length && isPathSeparatorCode(value.charCodeAt(start))) {
    start += 1;
  }
  return start === 0 ? value : value.slice(start);
}

/**
 * 路径相等比较。Windows 文件系统大小写不敏感 → 同一目录的不同大小写表示(`C:\Repo`
 * vs `c:\repo`)应视为相等;否则会把同一 workspace 误判成不同(跨平台审计 P2)。
 * 非 Windows 严格相等 —— 故在 mac/Linux 上与 `===` 字节等价,零行为变化。
 */
export function pathEquals(a: string, b: string): boolean {
  if (a === b) return true;
  return isWindowsRuntime() && lowerIfNeeded(a) === lowerIfNeeded(b);
}

/**
 * `filePath` 是否等于 `base` 或位于 `base` 之下(分隔符无关 + 平台感知大小写)。
 * 跨平台审计 P2 的单一来源:workspace root 归属(close-tabs-outside-root / Explorer 展开
 * 路径)、删除/改名路径匹配此前在 editor.store / FolderTree 各自手写 `startsWith(root+'/')`,
 * 漏了两类跨平台缺陷 →(a)`base` 本身是文件系统根(POSIX `/`、Windows `C:\`)时 `root+'/'`
 * 拼成 `//`/`C:\\` 令其下文件全不匹配;(b)Windows 大小写敏感 startsWith 把同一目录的不同
 * 大小写表示(`C:\Repo` vs `c:\repo`)判成不在内 → 误关 clean tab(丢编辑会话)/ 删除不关
 * (旧路径写入复活文件)/ 展开状态错乱。
 * - 尾部分隔符无关;`base` 去尾分隔符后为空(纯分隔符根,如 POSIX `/`)→ 任意路径都算内。
 * - 大小写与 `pathEquals` 同策:Windows 运行时不敏感,mac/Linux 严格(零行为变化)。
 */
export function isSameOrInsidePath(base: string, filePath: string): boolean {
  const windows = isWindowsRuntime();
  const fold = (s: string): string => (windows ? lowerIfNeeded(s) : s);
  const stripped = trimTrailingSeparators(base);
  if (stripped === '') return true; // base 为纯分隔符根(如 "/")→ 其下任意路径都算内
  const b = fold(stripped);
  const fp = fold(filePath);
  if (fp === b) return true;
  return fp.startsWith(`${b}/`) || fp.startsWith(`${b}\\`);
}

/**
 * isSameOrInsidePath 的「祖先索引」拆分(perf:批量 N×M 两两比较 → 每路径 O(depth) 次查表)。
 * 与 isSameOrInsidePath(base, p) 精确等价:base 的比较键 = fold(trimTrailingSeparators(base));
 * p 被 base 覆盖 ⇔ 键为 '' 或 键 ∈ containmentCandidates(fold(p))。fold 与 isSameOrInsidePath
 * 同策(Windows 运行时 lowerIfNeeded,否则原样),调用方每批取一次。
 */
export function containmentFold(): (s: string) => string {
  return isWindowsRuntime() ? lowerIfNeeded : (s) => s;
}

/** base 在 containmentFold 下的比较键(isSameOrInsidePath 的 `b`;纯分隔符根为 '')。 */
export function containmentKey(base: string, fold: (s: string) => string): string {
  return fold(trimTrailingSeparators(base));
}

/**
 * 已折叠路径 fp 的全部候选覆盖键:fp 本身 + 每个分隔符前的前缀(`fp.startsWith(b + sep)` 的全部 b)。
 * 键 '' 恒覆盖,调用方单独判断。visit 返回 true 即提前停止,本函数随之返回 true。
 */
export function someContainmentCandidate(fp: string, visit: (key: string) => boolean): boolean {
  if (visit(fp)) return true;
  for (let k = 1; k < fp.length; k++) {
    if (isPathSeparatorCode(fp.charCodeAt(k)) && visit(fp.slice(0, k))) return true;
  }
  return false;
}

/** Windows 盘符绝对路径 `C:\\` / `C:/`(冒号后须紧跟分隔符;`C:relative` 是盘符相对路径,不算绝对)。 */
export function isWindowsDriveAbsolute(p: string): boolean {
  return (
    p.length >= 3 &&
    isAsciiAlphaCode(p.charCodeAt(0)) &&
    p.charCodeAt(1) === 58 &&
    isPathSeparatorCode(p.charCodeAt(2))
  );
}

/** Windows UNC 路径 `\\\\server\\share`。 */
export function isUncPath(p: string): boolean {
  return p.charCodeAt(0) === 92 && p.charCodeAt(1) === 92;
}

/**
 * 跨平台绝对路径判定(renderer 无 node:path):POSIX `/…`、Windows 盘符 `C:\\` / `C:/`、UNC `\\\\server\\share`。
 * 编辑器链接解析、插件 SDK editor.openFile 守卫共用(此前定义在 Editor 内部,链接解析又把盘符 / UNC 子判断重写一遍)。
 */
export function isAbsolutePath(path: string): boolean {
  if (path.length === 0) return false;
  return path.charCodeAt(0) === 47 || isUncPath(path) || isWindowsDriveAbsolute(path);
}

/**
 * 跨平台 dirname:吃 `/` 与 `\`。先去尾部分隔符,取最后一个分隔符位置;
 * 无分隔符 → `''`(裸文件名);分隔符在 0 位(POSIX 根下直接项)→ `'/'`;
 * 父段是裸盘符 `X:`(Windows 盘根下直接项)→ `'X:\\'`(盘根)。
 *
 * 例:`/a/b` → `/a`;`/a/b/` → `/a`;`/a` → `/`;`a` → `''`;`C:\\x\\y` → `C:\\x`;
 *     `C:\\foo` → `C:\\`(盘根,**不是** `C:` —— 后者是「该盘当前目录」,会被当成
 *     另一路径 → listDir/invalidateChildrenIds 读错目录、UI 不刷新)。
 */
export function dirname(p: string): string {
  const trimmed = trimTrailingSeparators(p);
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return '';
  const head = trimmed.slice(0, idx);
  // Windows 盘根:`C:\foo` 的父是盘根 `C:\`,不是 drive-relative `C:`。与 POSIX `/a → /`
  // 同等(根下直接项的父=根)。跨平台复查 P2。
  if (isBareWindowsDrive(head)) return `${head}\\`;
  return head || '/';
}

/**
 * 跨平台 basename:**先去尾部分隔符**再取最后一段(吃 `/` 与 `\\`)。`/a/b/` → `b`、`/a` → `a`。
 * Explorer(root entry name / 面包屑)与 Editor(tab 标题)共用。
 */
export function basename(p: string): string {
  const trimmed = trimTrailingSeparators(p);
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
