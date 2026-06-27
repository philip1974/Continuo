// 外部 URL 长度上限单一来源(E190;E179/shell.openExternal 同值收口)。main + renderer 共用:
//  - main:windowOpenHandler(window.open url,E190)、shell.ipc openExternal schema。
//  - renderer:Markdown link resolveLink 外链分支(E179)。
// 外部 URL(交系统浏览器/协议处理器)远超真实链接长度即视为畸形/放大向量:超长 url 会让主进程先做
// 大字符串 URL 解析、并可能把巨大 URL 交给 OS 协议处理器。2048 是常见浏览器/服务器 URL 实务上限量级。
export const MAX_EXTERNAL_URL_LEN = 2048;

// 窗口/导航 URL 长度上限(E196)。与外链不同:窗口 URL 是 renderer 自己的 file:// URL + 启动 query
// (workspace 路径 ≤ FS_PATH_MAX 8192,URL-encode 最坏 ~3×,加 windowSeq/fresh/popout/spike)。query 部分
// renderer 侧已 cap 64KiB(MAX_STARTUP_QUERY_LEN),故窗口 URL 全长上限取同量级 64KiB —— 足以容纳任何合法
// 窗口 URL,又能挡住畸形超长 URL 在主进程热路径(isPopoutUrl 对 webContents.getURL() 反复调用)被完整解析。
export const MAX_WINDOW_URL_LEN = 65536;
