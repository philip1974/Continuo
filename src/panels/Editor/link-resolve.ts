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

export type LinkTarget =
  | { kind: 'file'; absPath: string }
  | { kind: 'external'; url: string };

const SAFE_EXTERNAL_SCHEME = /^(https?|mailto):/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** 取 currentFilePath 所在目录(`/` 或 `\\` 作分隔符);裸文件名返 null. */
function dirnameOf(p: string): string | null {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (idx < 0) return null;
  return p.slice(0, idx);
}

/** 简单 posix 风格 normalize:去 `.` 段,弹 `..` 段;保留前导 `/`. */
function normalize(p: string): string {
  const leadingSlash = p.startsWith('/');
  const segs: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segs.length > 0) segs.pop();
      continue;
    }
    segs.push(seg);
  }
  return (leadingSlash ? '/' : '') + segs.join('/');
}

export function resolveLink(
  href: string,
  currentFilePath: string | null,
): LinkTarget | null {
  if (!href) return null;

  // 纯锚点(本文档内导航)— IDE 不接管
  if (href.startsWith('#')) return null;

  // protocol 链接
  if (ANY_SCHEME.test(href)) {
    if (SAFE_EXTERNAL_SCHEME.test(href)) {
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
  if (pathPart.startsWith('/')) {
    absPath = pathPart;
  } else {
    if (!currentFilePath) return null;
    const dir = dirnameOf(currentFilePath);
    if (dir === null) return null;
    absPath = `${dir}/${pathPart}`;
  }

  return { kind: 'file', absPath: normalize(absPath) };
}
