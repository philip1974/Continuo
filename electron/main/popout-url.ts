// 主进程侧的 popout 子窗口判定。必须与 renderer 的 src/lib/popout-mode.ts
// 保持同一语义:用 URLSearchParams 精确取 `popout` query === '1',而不是裸
// 子串 `includes('popout=1')` —— 后者会把 workspace 路径 / 其它 query 值里恰好
// 含 `popout=1` 的普通主窗误判成 popout(进而 setMenu(null) + 禁 Cmd+R)。
import { MAX_WINDOW_URL_LEN } from '../shared/url-limits';

const POPOUT_FLAG = 'popout';

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
    return url.searchParams.get(POPOUT_FLAG) === '1';
  } catch {
    return false;
  }
}
