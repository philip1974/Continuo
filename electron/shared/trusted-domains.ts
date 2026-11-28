// 外链受信域名(对齐 VSCode 链接保护:src/vs/platform/url/common/trustedDomains.ts isURLDomainTrusted、
// src/vs/workbench/contrib/url/browser/trustedDomains.ts configureOpenerTrustedDomainsHandler)。main 的外链出口在打开
// http(s) 链接前用它判断是否要先确认;renderer 设置页用同一份规则显示 / 校验。纯函数,两侧共用。
// BDD: src/__tests__/external-link-trusted-domains/

/**
 * 默认受信(不可删除,VSCode product.json linkProtectionTrustedDomains 的对应物):只有本应用自己的仓库主页
 * (帮助菜单的文档 / 发行说明 / 报告问题都在其下)。VSCode 默认信任微软 / GitHub 的一组域名,那是它自己的产品域名;
 * Continuo 的产品域名就是这个仓库,其余由用户按需添加。localhost / 127.0.0.1 / [::1] 始终受信(同 VSCode)。
 */
export const DEFAULT_TRUSTED_DOMAINS: readonly string[] = Object.freeze(['https://github.com/philip1974/Continuo']);

/** 「信任所有域(禁用链接保护)」。 */
export const TRUST_ALL_DOMAINS = '*';

/** 用户受信域名条目上限与单条长度上限(持久化与 IPC 校验共用)。 */
export const TRUSTED_DOMAINS_MAX = 500;
export const TRUSTED_DOMAIN_MAX_LEN = 256;

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseHttpUrl(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** 是否为 http(s) 链接(只有这两种 scheme 走受信域名确认;mailto 等由 scheme 白名单单独把关,同 VSCode)。 */
export function isHttpUrl(url: string): boolean {
  return parseHttpUrl(url) !== null;
}

/** 规范化主机名(小写 + punycode),失败 → null。模式里的 `*.` 前缀由调用方先剥掉。 */
function canonicalHost(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

/** github.com 的路径不区分大小写(VSCode normalizeURLForTrust 同)。 */
function comparablePath(host: string, path: string): string {
  return host === 'github.com' ? path.toLowerCase() : path;
}

function matchesPattern(u: URL, pattern: string): boolean {
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]+)(\/[^?#]*)?$/i.exec(pattern.trim());
  if (!m) return false;
  const [, scheme, authority, rawPath] = m;
  // 没写 scheme 的模式同时匹配 http 与 https(VSCode testUrlMatchesGlob)
  if (scheme !== undefined && `${scheme.toLowerCase()}:` !== u.protocol) return false;
  let host = authority!;
  let port: string | null = null;
  const colon = host.lastIndexOf(':');
  if (colon > host.lastIndexOf(']')) {
    port = host.slice(colon + 1);
    host = host.slice(0, colon);
  }
  // 端口:模式写 `:*` = 任意端口;写了具体端口须相同;没写 = 默认端口
  if (port === '*') {
    // 任意端口
  } else if ((port ?? '') !== u.port) {
    const defaultPort = u.protocol === 'https:' ? '443' : '80';
    if (!(port === defaultPort && u.port === '')) return false;
  }
  const wildcard = host.startsWith('*.');
  const base = canonicalHost(wildcard ? host.slice(2) : host);
  if (base === null || base === '') return false;
  // `*.example.com` 匹配 example.com 本身及其任意层子域名(VSCode:「Either match no subdomains or match and remove a subdomain」)
  const hostOk = wildcard ? u.hostname === base || u.hostname.endsWith(`.${base}`) : u.hostname === base;
  if (!hostOk) return false;
  const path = (rawPath ?? '').replace(/\/+$/, '');
  if (path === '') return true;
  // 路径前缀按段匹配(/a 匹配 /a 与 /a/b,不匹配 /ab);u.pathname 已由 URL 解析消去 `.` / `..` 段
  const want = comparablePath(base, path);
  const have = comparablePath(u.hostname, u.pathname.replace(/\/+$/, ''));
  return have === want || have.startsWith(`${want}/`);
}

/**
 * http(s) 链接是否受信(打开前无需确认)。含用户信息(`user@host`)的链接一律不受信:`https://github.com@evil.example`
 * 之类显示名与真实主机不一致(VSCode isURLSafeForTrust)。`*` = 信任所有。非 http(s) / 解析失败 → false。
 */
export function isUrlTrusted(url: string, patterns: readonly string[]): boolean {
  const u = parseHttpUrl(url);
  if (!u) return false;
  if (patterns.includes(TRUST_ALL_DOMAINS)) return true;
  if (u.username !== '' || u.password !== '') return false;
  if (LOCALHOST_HOSTS.has(u.hostname) || u.hostname.endsWith('.localhost')) return true;
  return patterns.some((p) => matchesPattern(u, p));
}

export interface TrustChoice {
  /** 要加入受信列表的模式。 */
  readonly pattern: string;
  /** 文案用:显示给用户的对象(源 / 域名)。 */
  readonly label: string;
  readonly kind: 'origin' | 'subdomains' | 'all-ports' | 'all';
}

/**
 * 「配置受信任的域」可选项(VSCode configureOpenerTrustedDomainsHandler):信任 <scheme://host[:port]>;
 * 域名 → 信任 <末两级域名> 及其所有子域(`*.example.com`);IPv4 带端口 → 该地址的所有端口;最后是信任所有域。
 */
export function trustChoicesFor(url: string): TrustChoice[] {
  const u = parseHttpUrl(url);
  if (!u) return [];
  const origin = `${u.protocol}//${u.host}`;
  const out: TrustChoice[] = [{ pattern: origin, label: origin, kind: 'origin' }];
  const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname);
  if (isIPv4) {
    if (u.port !== '') out.push({ pattern: `${u.protocol}//${u.hostname}:*`, label: u.hostname, kind: 'all-ports' });
  } else if (!u.hostname.startsWith('[')) {
    const end = u.hostname.split('.').slice(-2).join('.');
    out.push({ pattern: `*.${end}`, label: end, kind: 'subdomains' });
  }
  out.push({ pattern: TRUST_ALL_DOMAINS, label: TRUST_ALL_DOMAINS, kind: 'all' });
  return out;
}

/** 校验 / 规整用户受信列表:去空白、去空串与重复、限长限量(超出的丢弃)。 */
export function normalizeTrustedDomains(list: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (s === '' || s.length > TRUSTED_DOMAIN_MAX_LEN || out.includes(s)) continue;
    out.push(s);
    if (out.length >= TRUSTED_DOMAINS_MAX) break;
  }
  return out;
}
