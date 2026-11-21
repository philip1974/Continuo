// 插件 app.network.fetch 输入上限(与 shell-limits/fs-limits 同族:发 raw fetch 前预检)。
//
// 边界(E264):network 是唯一在发原生调用前**没有**输入边界闸的插件能力(fs=assertPluginFsPath /
// shell=validateShellInput / clipboard·notify 等都有)。获得 network 权限的畸形插件可把超长 URL、
// 海量/超长 headers 交给浏览器网络栈同步解析,造成(与插件共享的)renderer 卡顿/内存峰值。URL 与
// headers 由 fetch 同步解析,是清晰的放大面,取**宽松**上限(合法用例永不触及,真实 HTTP 服务器对
// URL/header 普遍有 ~8KB 量级硬上限,更长的请求服务器侧也会拒)。
//
// 注:request body 不在此 cap —— body 由浏览器**流式**发送(不在 renderer 同步物化放大),且插件
// 若要传大 body 早已在自己 renderer 物化;给 body 设大小上限会限制合法上传能力(策略决策),故此处
// 仅约束同步解析的 URL/headers,body 上限留作单独策略议题。

export const NETWORK_URL_MAX = 8192; // URL 串长上限(真实 HTTP 服务器普遍 ~8KB)
export const NETWORK_HEADERS_MAX = 256; // header 条数上限
export const NETWORK_HEADER_KEY_MAX = 1024; // 单 header name 长度上限
export const NETWORK_HEADER_VALUE_MAX = 16384; // 单 header value 长度上限(容 JWT/cookie)
