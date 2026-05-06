// co:// 协议路由(M-Plugin v4.4)。
//
// 当前默认路由:
//   co://command/<commandId>?...  → app.commands.execute(commandId)
//
// 未来可扩 co://panel/<type>?file=... 等;留给 plugin 用 ProtocolRegistry
// 注册 path-based handler(本期未做,缺真实需求)。
//
// 解析失败 / commandId 不存在 → console.warn,不抛(避免外部 URL 把 LM 弄崩)。

import type { CoApp } from '../types';

export interface ParsedProtocolUrl {
  readonly action: string;       // 'command' | 'panel' | ...
  readonly target: string;       // commandId / panel type
  readonly params: Readonly<Record<string, string>>;
}

export function parseProtocolUrl(url: string): ParsedProtocolUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'co:') return null;
  // co://command/<id>:host='command',pathname='/<id>'
  const action = parsed.host;
  const target = parsed.pathname.replace(/^\/+/, '');
  if (!action || !target) return null;
  const params: Record<string, string> = {};
  parsed.searchParams.forEach((v, k) => {
    params[k] = v;
  });
  return { action, target, params };
}

export async function handleProtocolUrl(
  url: string,
  app: Pick<CoApp, 'commands'>,
): Promise<void> {
  const parsed = parseProtocolUrl(url);
  if (!parsed) {
    console.warn(`[protocol] invalid co:// URL: ${url}`);
    return;
  }

  if (parsed.action === 'command') {
    try {
      await app.commands.execute(parsed.target);
    } catch (err) {
      console.warn(
        `[protocol] command "${parsed.target}" failed:`,
        err,
      );
    }
    return;
  }

  console.warn(`[protocol] unsupported action "${parsed.action}" in ${url}`);
}
