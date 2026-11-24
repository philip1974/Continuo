import { WINDOW_QUERY, WINDOW_QUERY_FLAG_ON } from '../shared/window-query';
export type SpikeReason = 'dev' | 'env-opt-in' | 'packaged-blocked' | 'env-missing';

export interface SpikeAllowedInput {
  url: string;
  argv: string[];
  packaged: boolean;
}

export interface SpikeAllowedResult {
  allowed: boolean;
  reason: SpikeReason;
}

export interface RendererQueryInput {
  workspace?: string;
  windowSeq?: string;
  fresh?: boolean;
}

// 边界(E191,E190 同族):导航 URL 长度上限。spikeAllowed 每次导航(will-navigate/will-frame-navigate)
// 都对 url 跑正则;guardNav 阻止时把完整 url 写日志。畸形超长导航 URL 否则每次导航守卫扫描 +
// 保留巨大字符串。导航 URL = renderer file URL + workspace(≤2048)/windowSeq/spike query,8KiB 留足余量。
const MAX_NAV_URL_LEN = 8192;
const URL_LOG_MAX = 256;

/** 日志只记 url 截断摘要,防超长 url 写满日志(E191,E148 echo 族)。 */
function capUrlForLog(url: unknown): string {
  if (typeof url !== 'string') return String(url);
  return url.length > URL_LOG_MAX ? `${url.slice(0, URL_LOG_MAX)}…` : url;
}

export function spikeAllowed(input: SpikeAllowedInput): SpikeAllowedResult {
  const { url, argv, packaged } = input;
  if (!packaged) return { allowed: true, reason: 'dev' };

  if (process.env.CONTINUO_SPIKE === '1') {
    return { allowed: true, reason: 'env-opt-in' };
  }
  const envOptIn =
    argv.some((arg) => arg.startsWith('CONTINUO_SPIKE=1') || arg === '--spike');
  if (envOptIn) return { allowed: true, reason: 'env-opt-in' };
  const hasSpikeQuery = hasSpikeQueryParam(url);
  if (hasSpikeQuery) return { allowed: false, reason: 'packaged-blocked' };
  return { allowed: false, reason: 'env-missing' };
}

function hasSpikeQueryParam(url: unknown): boolean {
  // 边界(E191):非字符串/超长 url 不跑正则(O(N) 扫描),视为无 spike query(packaged 下两分支都拦)。
  if (typeof url !== 'string' || url.length > MAX_NAV_URL_LEN) return false;
  // 找 `?spike=` / `&spike=`(不构造 URL / 正则,同 E191 的线性扫描)。
  const key = `${WINDOW_QUERY.SPIKE}=`;
  for (let i = 0; i < url.length - key.length; i += 1) {
    const sep = url.charCodeAt(i);
    if ((sep === 63 || sep === 38) && url.startsWith(key, i + 1)) return true;
  }
  return false;
}

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

export function guardNav(
  event: { preventDefault: () => void },
  url: string,
  packaged: boolean,
): SpikeAllowedResult {
  const result = spikeAllowed({ url, argv: process.argv, packaged });
  if (!result.allowed) {
    event.preventDefault();
    console.warn('[spike-gate] guardNav blocked', {
      url: capUrlForLog(url), // 边界(E191):日志只记截断摘要
      reason: result.reason,
    });
  }
  return result;
}

// 无 guardOpen(安全 L1):window.open 不另设 spike 闸 —— windowOpenHandler 只放行 query 恰好为 popout=1 的
// 本应用入口(electron/main/popout-url.ts isPopoutOnlyUrl),带 ?spike= 的 URL 在那里一律被拒。原 guardOpen
// 从未接入,且 packaged 下凡无 opt-in 一律 deny,照接会拒掉全部 popout。

interface NavEvent {
  preventDefault(): void;
  readonly url: string;
}

interface SpikeGateContents {
  on(
    event: 'will-navigate' | 'will-frame-navigate',
    listener: (event: NavEvent) => void,
  ): void;
}

export function installSpikeGate(
  contents: SpikeGateContents,
  packaged: boolean,
): void {
  const handler = (event: NavEvent) => guardNav(event, event.url, packaged);

  contents.on('will-navigate', handler);
  contents.on('will-frame-navigate', handler);
}
