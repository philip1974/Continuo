// 主进程侧的 popout 子窗口判定。必须与 renderer 的 src/lib/popout-mode.ts
// 保持同一语义:用 URLSearchParams 精确取 `popout` query === '1',而不是裸
// 子串 `includes('popout=1')` —— 后者会把 workspace 路径 / 其它 query 值里恰好
// 含 `popout=1` 的普通主窗误判成 popout(进而 setMenu(null) + 禁 Cmd+R)。
const POPOUT_FLAG = 'popout';

export function isPopoutUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.searchParams.get(POPOUT_FLAG) === '1';
  } catch {
    return false;
  }
}
