// 多窗口启动 workspace 注入(issue #23 Phase 1)。
//
// main 通过 ?workspace=<encoded path> 给新主窗口指定要打开的目录;renderer 端
// hydrate 时优先用此值,跳过 explorer.json 里的 workspace.current,实现多窗口
// 看不同 folder。无 query 时返 null,走原 explorer.json 持久化路径(主窗口默认)。

const WORKSPACE_PARAM = 'workspace';

/**
 * 从 query string 解 ?workspace=<path>。
 *  - 缺失 / 空 / 仅空白 → null
 *  - URL-encoded 路径自动解码
 *  - 多个 workspace 参数取第一个
 *  - 输入容错:可带或不带 `?` 前缀
 */
export function parseInitialWorkspace(search: string): string | null {
  if (!search) return null;
  const normalized = search.startsWith('?') ? search.slice(1) : search;
  if (!normalized) return null;
  const params = new URLSearchParams(normalized);
  const raw = params.get(WORKSPACE_PARAM);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}
