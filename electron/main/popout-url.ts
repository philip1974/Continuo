// 主进程侧的 popout 子窗口判定。必须与 renderer 的 src/lib/popout-mode.ts
// 保持同一语义:用 URLSearchParams 精确取 `popout` query === '1',而不是裸
// 子串 `includes('popout=1')` —— 后者会把 workspace 路径 / 其它 query 值里恰好
// 含 `popout=1` 的普通主窗误判成 popout(进而 setMenu(null) + 禁 Cmd+R)。
import { MAX_WINDOW_URL_LEN } from '../shared/url-limits';
import { WINDOW_QUERY, WINDOW_QUERY_FLAG_ON } from '../shared/window-query';

const POPOUT_FLAG = WINDOW_QUERY.POPOUT;

export function isPopoutUrl(rawUrl: string): boolean {
  // 边界(E196,renderer isPopoutWindow E195 主进程对偶):isPopoutUrl 在窗口创建 / agent-auth 选主窗 /
  // MCP fallback 选窗口等热路径对 webContents.getURL() 反复调用。new URL(rawUrl) 是 O(N) 解析 —— 畸形超长
  // 窗口 URL 否则在这些热路径被完整解析,与 renderer 侧长度闸不对称。超 MAX_WINDOW_URL_LEN 必非法,按非
  // popout 返 false(合法窗口 URL 远小于此)。
  if (typeof rawUrl !== 'string' || rawUrl.length > MAX_WINDOW_URL_LEN) {
    return false;
  }
  try {
    const url = new URL(rawUrl);
    return url.searchParams.get(POPOUT_FLAG) === WINDOW_QUERY_FLAG_ON;
  } catch {
    return false;
  }
}

/**
 * window.open 放行用(安全 L1):query 恰好只有 `popout=1` 一项。windowOpenHandler 对本应用入口
 * 放行并注入完整 preload,只为 dockview popout;popout 子窗只看这个标记(App 短路成 PopoutHost),
 * 用不到 workspace / windowSeq / fresh。带任何其它参数 —— 例如 Markdown 预览里中键点
 * `index.html?workspace=%2F&fresh=1&windowSeq=0` —— 一律拒,否则会开出以攻击者指定目录为根的完整应用窗口。
 * renderer 侧 popoutUrlFor 只产出这种形态。
 */
export function isPopoutOnlyUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.length > MAX_WINDOW_URL_LEN) {
    return false;
  }
  try {
    const params = new URL(rawUrl).searchParams;
    return params.get(POPOUT_FLAG) === WINDOW_QUERY_FLAG_ON && [...params.keys()].length === 1;
  } catch {
    return false;
  }
}
