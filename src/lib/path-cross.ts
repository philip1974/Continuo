// 跨平台路径小工具(renderer 没有 node:path)。
//
// renderer 多处用 `${dir}/${name}` 拼路径、用 `root + '/'` 前缀剥离,在 Windows 上
// (路径用 `\`)会产生混合分隔符或前缀失配,导致 tab id / watch 广播 / 相对路径显示
// 不一致(跨平台审计 P1/P2)。这里统一两个分隔符无关的纯函数。

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
 * 跨平台审计 P2(codex):用 isSameOrInsidePath 做归属判定 —— 修两处缺陷 →(a)裸
 * `startsWith(root)` 缺路径边界:`/root` 会错剥 `/rooted/a` 成 `ed/a`;(b)Windows 大小写
 * 敏感:`c:\repo` 剥 `C:\Repo\src\a.ts` 失配 → Copy Relative Path 出绝对路径。切片仍按原
 * `root.length`(大小写折叠不改长度)。
 */
export function stripRootPrefix(root: string, p: string): string {
  if (!isSameOrInsidePath(root, p)) return p;
  return trimLeadingSeparators(p.slice(root.length));
}

function isWindowsRuntime(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform ?? '';
  return (
    platform.length >= 3 &&
    (platform.charCodeAt(0) | 32) === 119 &&
    (platform.charCodeAt(1) | 32) === 105 &&
    (platform.charCodeAt(2) | 32) === 110
  );
}

function isPathSeparatorCode(code: number): boolean {
  return code === 47 || code === 92;
}

function isAsciiAlphaCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isBareWindowsDrive(value: string): boolean {
  return (
    value.length === 2 &&
    isAsciiAlphaCode(value.charCodeAt(0)) &&
    value.charCodeAt(1) === 58
  );
}

function trimTrailingSeparators(value: string): string {
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

function lowerIfNeeded(value: string): string {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code >= 65 && code <= 90) || code > 127) {
      return value.toLowerCase();
    }
  }
  return value;
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
