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

// 边界(E55):renderer 防御性上限 —— 即便 main 已 cap(MAX_PROTOCOL_URL_LEN/队列),parseProtocolUrl
// 也自带长度 + params 数量上限,挡绕过 main 的测试/未来入口(深链解析在 new URL/遍历 query 处会被
// 超长 URL / 海量 params 放大)。值与 main protocol-dispatch 的 MAX_PROTOCOL_URL_LEN 对齐。
const MAX_PARSE_URL_LEN = 8192;
const MAX_PARSE_PARAMS = 256;
// 边界(E98):字段级长度上限。E55 只限 URL 总长 + params 数量,但 8KB 内仍可塞超长单字段
// (co://<8k-host>/<8k-target>?<huge-key>=<huge-value>)完整进返回对象 + 日志放大。
const MAX_ACTION_LEN = 256;
const MAX_TARGET_LEN = 256;
const MAX_PARAM_KEY_LEN = 128;
const MAX_PARAM_VALUE_LEN = 1024;

/** 边界(E98):日志只打印截断摘要,不把超长 URL/字段原样拼进 console.warn。 */
function truncForLog(s: string, max = 128): string {
  return s.length > max ? `${s.slice(0, max)}…(len=${s.length})` : s;
}

function stripLeadingSlashes(pathname: string): string {
  let start = 0;
  while (start < pathname.length && pathname.charCodeAt(start) === 47) {
    start += 1;
  }
  return start === 0 ? pathname : pathname.slice(start);
}

export function parseProtocolUrl(url: string): ParsedProtocolUrl | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_PARSE_URL_LEN) {
    return null; // 边界(E55):非法/超长 URL 不解析
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'co:') return null;
  // co://command/<id>:host='command',pathname='/<id>'
  const action = parsed.host;
  const target = stripLeadingSlashes(parsed.pathname);
  if (!action || !target) return null;
  // 边界(E98):action/target 单字段上限,超限视为畸形 → null。
  if (action.length > MAX_ACTION_LEN || target.length > MAX_TARGET_LEN) {
    return null;
  }
  const params: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of parsed.searchParams) {
    if (count >= MAX_PARSE_PARAMS) break; // 边界(E55):params 数量上限
    // 边界(E98):超长 param key/value 跳过(不进返回对象,防字段放大)。
    if (k.length > MAX_PARAM_KEY_LEN || v.length > MAX_PARAM_VALUE_LEN) continue;
    params[k] = v;
    count += 1;
  }
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
    // 边界(E98):拒绝路径只打印截断摘要(url 可达 8KB)。
    console.warn(`[protocol] invalid co:// URL: ${truncForLog(url)}`);
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

  // 边界(E99,E98 兄弟分支):unsupported action 分支也截断日志 —— url 可达 8KB,
  // 合法但不支持的 co://panel/...?... 绕过 invalid 分支会在此完整输出(E98 日志放大修复未传播)。
  // parsed.action 已被 parseProtocolUrl 截到 ≤256,url 用 truncForLog。
  console.warn(
    `[protocol] unsupported action "${parsed.action}" in ${truncForLog(url)}`,
  );
}
