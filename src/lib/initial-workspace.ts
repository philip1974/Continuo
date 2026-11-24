// 多窗口启动 workspace 注入(issue #23 Phase 1)。
//
// main 通过 ?workspace=<encoded path> 给新主窗口指定要打开的目录;renderer 端
// hydrate 时优先用此值,跳过 explorer.json 里的 workspace.current,实现多窗口
// 看不同 folder。无 query 时返 null,走原 explorer.json 持久化路径(主窗口默认)。

import { isBlankString } from './blank-string';
import { WINDOW_QUERY, WINDOW_QUERY_FLAG_ON } from '../../electron/shared/window-query';

const WORKSPACE_PARAM = WINDOW_QUERY.WORKSPACE;
const WINDOW_SEQ_PARAM = WINDOW_QUERY.WINDOW_SEQ;
const FRESH_PARAM = WINDOW_QUERY.FRESH;

// 边界(E193,外部输入长度上限族 E152/E179/E190/E191):启动 query 总长度上限。safeStartupParams 被
// parseInitialWorkspace/WindowSeq/Fresh 三处在 renderer 启动早期各调一次 —— 同一畸形超长
// location.search 否则会被 new URLSearchParams 重复解析三次,早于任何字段级校验就产生 CPU/内存峰值。
// 合法启动 query = ?workspace=<encoded path>&windowSeq=<int>&fresh=1。workspace 路径在入口处限
// FS_PATH_MAX(8192)个 UTF-16 单元;URL-encode 后 ASCII 约 1–3×,非 ASCII BMP 字符(如中文)每个 9 字节。
// 真实可开的目录受 OS 路径上限约束(macOS 1024 / Linux 4096 字节,在 stat 时即被拒),远在 64KiB 内;
// 理论上只有 Windows 长路径里数千个非 ASCII 字符才会超,超限直接当无 query(null)。
export const MAX_STARTUP_QUERY_LEN = 65536;

/**
 * 启动 query 安全解析(单一来源)。E193:超长 query 在 `new URLSearchParams`(O(N) 解析)之前直接拒,
 * 返 null。本 helper 被 parseInitialWorkspace/WindowSeq/Fresh 与 popout-mode 复用(同一外部 location.search
 * 的所有解析点共用长度闸)。
 */
export function safeStartupParams(search: string): URLSearchParams | null {
  if (!search) return null;
  // 边界(E193):超长 query 在 new URLSearchParams(O(N) 解析)之前直接拒,绝不重复解析。
  if (search.length > MAX_STARTUP_QUERY_LEN) return null;
  const normalized = search.startsWith('?') ? search.slice(1) : search;
  if (!normalized) return null;
  return new URLSearchParams(normalized);
}

function isUnsignedDecimal(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/**
 * 从 query string 解 ?workspace=<path>。
 *  - 缺失 / 空 / 仅空白 → null
 *  - URL-encoded 路径自动解码
 *  - 多个 workspace 参数取第一个
 *  - 输入容错:可带或不带 `?` 前缀
 */
export function parseInitialWorkspace(search: string): string | null {
  const params = safeStartupParams(search);
  if (!params) return null;
  const raw = params.get(WORKSPACE_PARAM);
  if (raw === null) return null;
  // 仅判断是否全空白;**返回原始值不 trim** —— 文件系统允许前后带空格的
  // 合法路径(e.g. '/tmp/proj '),与 workspace.store「不 trim 空白」契约(尾分隔符由 normalizeWorkspaceRoot 去除)
  // 一致。此前 return trimmed 会破坏这类路径(跨平台审计 P2)。
  if (isBlankString(raw)) return null;
  return raw;
}

/**
 * 从 query string 解 ?windowSeq=<N>。
 *  - 缺失 / 非数字 / 负数 / 浮点 → 默认 0(主窗位)
 *  - 防 renderer 注入坏值导致段索引乱
 */
export function parseInitialWindowSeq(search: string): number {
  const params = safeStartupParams(search);
  if (!params) return 0;
  const raw = params.get(WINDOW_SEQ_PARAM);
  if (raw === null) return 0;
  // 严格整数:整数才接,小数 / 字母拒
  if (!isUnsignedDecimal(raw)) return 0;
  const n = Number(raw);
  // 边界(E8,E4/E7 同族):须 safe integer。`?windowSeq=9007199254740993`(> MAX_SAFE_INTEGER)
  // 经 Number 会舍入成 9007199254740992,Number.isInteger 仍为 true → 不可安全表示的 windowSeq
  // 进入持久化索引,致段匹配 / windowSeq+1 / 窗口恢复精度碰撞。不安全整数按非法值回退 0(主窗位)。
  if (!Number.isSafeInteger(n) || n < 0) return 0;
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
  const params = safeStartupParams(search);
  if (!params) return false;
  return params.get(FRESH_PARAM) === WINDOW_QUERY_FLAG_ON;
}
