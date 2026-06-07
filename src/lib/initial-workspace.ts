// 多窗口启动 workspace 注入(issue #23 Phase 1)。
//
// main 通过 ?workspace=<encoded path> 给新主窗口指定要打开的目录;renderer 端
// hydrate 时优先用此值,跳过 explorer.json 里的 workspace.current,实现多窗口
// 看不同 folder。无 query 时返 null,走原 explorer.json 持久化路径(主窗口默认)。

const WORKSPACE_PARAM = 'workspace';
const WINDOW_SEQ_PARAM = 'windowSeq';
const FRESH_PARAM = 'fresh';

function paramsOf(search: string): URLSearchParams | null {
  if (!search) return null;
  const normalized = search.startsWith('?') ? search.slice(1) : search;
  if (!normalized) return null;
  return new URLSearchParams(normalized);
}

/**
 * 从 query string 解 ?workspace=<path>。
 *  - 缺失 / 空 / 仅空白 → null
 *  - URL-encoded 路径自动解码
 *  - 多个 workspace 参数取第一个
 *  - 输入容错:可带或不带 `?` 前缀
 */
export function parseInitialWorkspace(search: string): string | null {
  const params = paramsOf(search);
  if (!params) return null;
  const raw = params.get(WORKSPACE_PARAM);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

/**
 * 从 query string 解 ?windowSeq=<N>。
 *  - 缺失 / 非数字 / 负数 / 浮点 → 默认 0(主窗位)
 *  - 防 renderer 注入坏值导致段索引乱
 */
export function parseInitialWindowSeq(search: string): number {
  const params = paramsOf(search);
  if (!params) return 0;
  const raw = params.get(WINDOW_SEQ_PARAM);
  if (raw === null) return 0;
  // 严格整数:整数才接,小数 / 字母拒
  if (!/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

/**
 * Issue #45:从 query string 解 ?fresh=1。
 *  - 只有显式 `fresh=1` 时返 true;其它(缺失 / `0` / `''` / `true`)一律 false。
 *  - main 仅在 dock 模式 / CLI argv / "open folder in new window" 等用户显式新开窗口
 *    场景设此 flag;restore-loop 不设,确保 explorer.json 段是唯一恢复源(并保留
 *    workspace query 作 corrupted-snap 的 fallback)。
 */
export function parseInitialFresh(search: string): boolean {
  const params = paramsOf(search);
  if (!params) return false;
  return params.get(FRESH_PARAM) === '1';
}
