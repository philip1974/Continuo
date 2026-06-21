// co:// 协议路由(M-Plugin v4.4)。
//
// 当前默认路由:
//   co://command/<commandId>?...  → app.commands.execute(commandId)
//
// 未来可扩 co://panel/<type>?file=... 等;留给 plugin 用 ProtocolRegistry
// 注册 path-based handler(本期未做,缺真实需求)。
//
// 解析失败 / commandId 不存在 → console.warn,不抛(避免外部 URL 把 LM 弄崩)。
//
// 安全 S5(codex 安全审计):co:// 是**跨应用边界**入口 —— 恶意网页 / 聊天消息 /
// README 链接诱导用户点 `co://command/<id>`,经 OS 协议 → main open-url/second-instance →
// 广播 renderer → 本 handler。旧实现对**任意** command id 无 allowlist/确认直接
// `commands.execute`,而第三方插件也经 `Plugin.addCommand` / 直接 `commands.register`
// 注册命令到**同一注册表** → 外部网页点击即可触发已安装插件的 fs/shell/network 命令
// (本地命令执行 / 文件读写 / 数据外传)。
//
// 修复:默认**禁止**深链执行任意命令,只放行 core 维护的 allowlist 内 id。allowlist
// **不**放在 CommandSpec(插件直接持有 commands.register,可自设字段自授权),而是
// core 独有的 id 集合,插件无法触碰。当前集合为空(co://command 路由无真实消费者)=
// 全部深链命令默认拒绝;未来若需放行某个明确只读/导航类**内置**命令,把其 id 加入。

import type { CoApp } from '../types';

/**
 * 安全 S5:允许被外部 co://command 深链唤起的命令 id 白名单(core 独有,插件无法修改)。
 * 默认空 = 拒绝一切外部深链命令执行。加入前必须确认该命令是纯只读/导航、无副作用,
 * 且非插件可冒名注册(用 core 内置且固定的 id)。
 */
export const EXTERNALLY_INVOKABLE_COMMANDS: ReadonlySet<string> =
  new Set<string>([
    // 例:确认为纯 UI 导航(打开命令面板让用户自选)后再加入对应内置 id。
  ]);

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
  // 安全 S5:可被深链唤起的命令 allowlist(默认 core 集合;注入便于测试)。
  allowlist: ReadonlySet<string> = EXTERNALLY_INVOKABLE_COMMANDS,
): Promise<void> {
  const parsed = parseProtocolUrl(url);
  if (!parsed) {
    console.warn(`[protocol] invalid co:// URL: ${url}`);
    return;
  }

  if (parsed.action === 'command') {
    // 安全 S5:默认禁止外部深链执行任意命令,只放行 core allowlist 内的 id。
    if (!allowlist.has(parsed.target)) {
      console.warn(
        `[protocol] 拒绝深链执行未授权命令 "${parsed.target}"` +
          `(安全 S5:外部 co://command 默认禁止执行任意命令,需 core allowlist 显式放行)`,
      );
      return;
    }
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
