import { startsWithAsciiIgnoreCase } from './lower-if-needed';

// 外部 URL 长度上限单一来源(E190;E179/shell.openExternal 同值收口)。main + renderer 共用:
//  - main:windowOpenHandler(window.open url,E190)、shell.ipc openExternal schema。
//  - renderer:Markdown link resolveLink 外链分支(E179)。
// 外部 URL(交系统浏览器/协议处理器)远超真实链接长度即视为畸形/放大向量:超长 url 会让主进程先做
// 大字符串 URL 解析、并可能把巨大 URL 交给 OS 协议处理器。2048 是常见浏览器/服务器 URL 实务上限量级。
export const MAX_EXTERNAL_URL_LEN = 2048;

/**
 * 外链 scheme 白名单:只有 http: / https: / mailto: 可以交给系统打开(`shell.openExternal`)。main 的
 * openExternal 入口与 renderer 的 Markdown 链接解析共用这一份 —— 此前两侧各写一份、靠注释提醒同步;
 * 两侧不一致时链接会被 renderer 判成外链再被 main 拒绝(点了没反应),或反过来。
 *
 * **不含 file:**(安全 S6):openExternal 的输入含远程不受信数据(marketplace 的 authorUrl / 评论 url、
 * markdown 链接、终端输出里的链接),放行 file: 会让 `file:///Applications/…`、Windows UNC
 * `file://attacker/share`(触发外连 + 凭据泄漏)被 OS 直接打开。本地文件导航走 IDE 内编辑器。
 */
export function startsWithAllowedExternalScheme(url: string): boolean {
  return (
    startsWithAsciiIgnoreCase(url, 'http:') ||
    startsWithAsciiIgnoreCase(url, 'https:') ||
    startsWithAsciiIgnoreCase(url, 'mailto:')
  );
}

// 窗口/导航 URL 长度上限(E196)。与外链不同:窗口 URL 是 renderer 自己的 file:// URL + 启动 query
// (workspace 路径 ≤ FS_PATH_MAX 8192,URL-encode 最坏 ~3×,加 windowSeq/fresh/popout/spike)。query 部分
// renderer 侧已 cap 64KiB(MAX_STARTUP_QUERY_LEN),故窗口 URL 全长上限取同量级 64KiB —— 足以容纳任何合法
// 窗口 URL,又能挡住畸形超长 URL 在主进程热路径(isPopoutUrl 对 webContents.getURL() 反复调用)被完整解析。
export const MAX_WINDOW_URL_LEN = 65536;
