// Markdown 链接解析(resolveLink)。
//
// 给定 link 的 href + 当前文件绝对路径,判定:
//   - external:已知安全 protocol(http/https/mailto),走系统默认 app
//   - file:相对 / 绝对路径(**无 scheme**),在 IDE 内 editor 打开
//   - null:纯锚点 / 未知或不安全 scheme(含 file:)/ 无 base 解相对
//
// 见 issue #25。安全:javascript: / tel: / 自定义 scheme 一律 null,防恶意
// markdown 通过 [text](javascript:...) 在主进程触发任意 protocol handler。
//
// 安全 S6(codex 安全审计):**file: scheme 不再当 external**(否则会经 OS openExternal
// 打开本地文件/UNC,markdown 来源可能不受信)。本地文件仍走无 scheme 的相对/绝对
// 路径 → kind:'file' 在 IDE 内打开。与 shell.service 白名单同步移除 file:。

import { MAX_EXTERNAL_URL_LEN } from '../../../electron/shared/url-limits';

export type LinkTarget =
  | { kind: 'file'; absPath: string }
  | { kind: 'external'; url: string };

// 边界(E179):href 长度上限。Markdown 链接 href 来自(可能恶意/损坏的)文件内容,非经 IPC schema。
// 无上限时点击超长链接会:file 分支跑 normalize(indexOf/slice/split O(n) + 数组分配);external 分支
// 把超长 URL 经 openExternal IPC structured-clone 后才被主进程 schema 拒 → renderer 卡顿/放大。
// 早返一个宽松硬上限(取两分支较大者 = 文件路径上限),外链分支再按 openExternal 上限细判。
const MAX_FILE_LINK_LEN = 8192; // 对齐 FS_PATH_MAX(文件链接路径)
// 外链上限用共享 MAX_EXTERNAL_URL_LEN(E190 收口:与 windowOpenHandler / shell.openExternal 单一来源)。
const MAX_EXTERNAL_LINK_LEN = MAX_EXTERNAL_URL_LEN;

const SAFE_EXTERNAL_SCHEME = /^(https?|mailto):/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// Windows 绝对路径:盘符 `C:\`/`C:/` 或 UNC `\\server`。必须在 ANY_SCHEME 之前甄别,
// 否则 `C:\foo.md` 会被 ANY_SCHEME 当成 `C:` scheme 拒绝(跨平台审计 P1)。
const WIN_DRIVE = /^[a-zA-Z]:[\\/]/;
const WIN_UNC = /^\\\\/;

/** 跨平台绝对路径:POSIX `/`、Windows 盘符、UNC。 */
function isAbsolutePathLike(p: string): boolean {
  return p.startsWith('/') || WIN_DRIVE.test(p) || WIN_UNC.test(p);
}

/** 取 currentFilePath 所在目录(`/` 或 `\\` 作分隔符);裸文件名返 null. */
function dirnameOf(p: string): string | null {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (idx < 0) return null;
  return p.slice(0, idx);
}

/**
 * 跨平台 normalize:去 `.` 段、弹 `..` 段。同时支持 `/` 与 `\` 分隔符,并保留路径根:
 *   - POSIX `/...`、Windows 盘符 `C:\`/`C:/`、UNC `\\server`。
 * join 时沿用根的分隔符(Windows 根 → `\`,POSIX/正斜杠盘符 → `/`),避免混合分隔符
 * 路径(跨平台审计 P2:`..\foo.md` 不折叠 / 混合分隔符)。
 */
function normalize(p: string): string {
  let root = '';
  let rest = p;
  if (WIN_UNC.test(p)) {
    // UNC:`\\server\share` 是**不可越过的根**(host+share 构成卷根,`..` 不得弹出)。
    // 跨平台审计 P2(codex):旧实现 root 仅取 `\\`,把 server/share 当可弹 segs → 相对
    // 链接 `..\..\a.md` 从 `\\server\share\dir\cur.md` 错解析成 `\\server\a.md`,应停在
    // `\\server\share\a.md`(与 drive/POSIX 的 root 不可弹一致)。
    const m = /^(\\\\[^\\/]+[\\/]+[^\\/]+)(?:[\\/]+|$)/.exec(p);
    if (m) {
      root = `${m[1]}\\`; // 统一带反斜杠尾(同 drive root "C:\")
      rest = p.slice(m[0].length);
    } else {
      root = '\\\\'; // 残缺 UNC(仅 \\server,无 share)→ 退回旧语义
      rest = p.slice(2);
    }
  } else if (WIN_DRIVE.test(p)) {
    root = p.slice(0, 3); // "C:\" 或 "C:/"
    rest = p.slice(3);
  } else if (p.startsWith('/')) {
    root = '/';
    rest = p.slice(1);
  }
  const sep = root.includes('\\') ? '\\' : '/';
  const segs = new Array<string>(rest.length);
  let segCount = 0;
  let start = 0;
  for (;;) {
    const slash = rest.indexOf('/', start);
    const backslash = rest.indexOf('\\', start);
    let end: number;
    if (slash < 0) end = backslash < 0 ? rest.length : backslash;
    else if (backslash < 0) end = slash;
    else end = Math.min(slash, backslash);
    if (end > start) {
      const seg = rest.slice(start, end);
      if (seg === '..') {
        if (segCount > 0) segCount -= 1;
      } else if (seg !== '.') {
        segs[segCount++] = seg;
      }
    }
    if (end >= rest.length) break;
    start = end + 1;
  }
  segs.length = segCount;
  return root + segs.join(sep);
}

export function resolveLink(
  href: string,
  currentFilePath: string | null,
): LinkTarget | null {
  if (!href) return null;

  // 边界(E179):href 硬长度上限,防超长链接进 normalize/split 或经 IPC 放大。超 MAX_FILE_LINK_LEN
  // (两分支较大者)直接拒,不进任何后续 O(n)/IPC 处理。
  if (href.length > MAX_FILE_LINK_LEN) return null;

  // 纯锚点(本文档内导航)— IDE 不接管
  if (href.startsWith('#')) return null;

  // protocol 链接(先排除 Windows 盘符/UNC 绝对路径,它们不是 URL scheme)
  if (!isAbsolutePathLike(href) && ANY_SCHEME.test(href)) {
    if (SAFE_EXTERNAL_SCHEME.test(href)) {
      // 边界(E179):外链上限对齐 openExternal,超限不进 IPC(否则超长 URL structured-clone 后才被主进程拒)。
      if (href.length > MAX_EXTERNAL_LINK_LEN) return null;
      return { kind: 'external', url: href };
    }
    // 不安全 / 未知 scheme:javascript / tel / 自定义 → 拒绝
    return null;
  }

  // 切掉 #section,只留路径部分
  const hashIdx = href.indexOf('#');
  const pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  if (!pathPart) return null;

  let absPath: string;
  if (isAbsolutePathLike(pathPart)) {
    absPath = pathPart;
  } else {
    if (!currentFilePath) return null;
    const dir = dirnameOf(currentFilePath);
    if (dir === null) return null;
    absPath = `${dir}/${pathPart}`;
  }

  return { kind: 'file', absPath: normalize(absPath) };
}
