// 主窗 renderer 入口 URL 的两件小事:dev server URL 解析、启动 query 组装(协议常量见 shared/window-query)。
import { WINDOW_QUERY, WINDOW_QUERY_FLAG_ON } from '../shared/window-query';

export interface RendererQueryInput {
  workspace?: string;
  windowSeq?: string;
  fresh?: boolean;
}

/** 主窗启动 query:只含 main 自己给出的 workspace / windowSeq / fresh。 */
export function buildRendererQuery(input: RendererQueryInput): Record<string, string> {
  const query: Record<string, string> = {};
  if (input.workspace) query[WINDOW_QUERY.WORKSPACE] = input.workspace;
  if (input.windowSeq) query[WINDOW_QUERY.WINDOW_SEQ] = input.windowSeq;
  if (input.fresh) query[WINDOW_QUERY.FRESH] = WINDOW_QUERY_FLAG_ON;
  return query;
}

// 边界(E299):dev 渲染 URL(ELECTRON_RENDERER_URL,electron-vite 注入)解析 —— createMainWindow 此前
// 直接 `new URL(process.env['ELECTRON_RENDERER_URL'])` 无 try/catch,缺失/畸形 env(开发误配)会抛 →
// createMainWindow 崩溃、应用启动无窗口。纯函数:不可解析返 null(调用方回退 loadFile),total 不抛。
// 边界(E302):new URL 前先限长(任何真实 dev renderer URL ~数十字符,远在内)。env 是开发误配/OS 上界
// 输入(非攻击面),此为「parse 前限长」纵深一致性(同 E295/E298 cap-before-parse)+ 明确上界。
const MAX_RENDERER_URL_LEN = 8192;
export function parseDevRendererUrl(rawUrl: string | undefined): URL | null {
  if (
    typeof rawUrl !== 'string' ||
    rawUrl.length === 0 ||
    rawUrl.length > MAX_RENDERER_URL_LEN
  )
    return null;
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}
