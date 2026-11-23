// 从进程 argv 里提取自定义协议(co://)深链 URL。
//
// Windows/Linux 没有 macOS 的 open-url 事件:协议深链通过 argv 传入(冷启动 process.argv
// 或运行中 second-instance 的 argv)。此前用大小写敏感的 `a.startsWith('co://')` 前缀匹配:
//   - 大写 scheme(`CO://...`)被丢弃(URL scheme 大小写不敏感)→ 深链不派发;
// 这里先做大小写无关的前缀匹配(无分配),不命中再用 `new URL()` 按 protocol 比较
// (跨平台审计 P2;调用方是 index.ts 的冷启动与 second-instance 两处)。

import { MAX_PROTOCOL_URL_LEN } from './protocol-dispatch';
import { lowerIfNeeded, startsWithAsciiIgnoreCase } from '../shared/lower-if-needed';

/** 在 argv 中找第一个 `<protocol>://` 深链;无则 null。protocol 不含冒号(如 'co')。 */
export function extractProtocolUrl(
  argv: readonly string[],
  protocol: string,
): string | null {
  const scheme = `${lowerIfNeeded(protocol)}:`;
  const schemePrefix = `${scheme}//`;
  for (const a of argv) {
    if (typeof a !== 'string' || a.length === 0) continue;
    // 边界(E152):在前缀匹配与 `new URL(a)` 解析之前先做长度上限。
    // 否则畸形/恶意超长 argv(冷启动 process.argv 或 second-instance argv)会在 routeProtocolUrl
    // 的 8KB 上限生效之前,先触发整串 URL 解析 → 放大启动 CPU/内存。
    // 超 MAX_PROTOCOL_URL_LEN 的串即便是合法深链也会被下游 routeProtocolUrl 拒,故直接跳过无损。
    if (a.length > MAX_PROTOCOL_URL_LEN) continue;
    if (startsWithAsciiIgnoreCase(a, schemePrefix)) return a;
    try {
      if (lowerIfNeeded(new URL(a).protocol) === scheme) return a;
    } catch {
      // 非合法 URL:不是深链,跳过(常见 `<protocol>://` 已在上方无分配处理)。
    }
  }
  return null;
}

/**
 * 把本程序注册为 `<protocol>://` 的系统默认处理者 —— 仅打包版。
 * dev(process.defaultApp:pnpm dev / e2e 以 `electron <入口>` 启动)不注册:macOS 的 LaunchServices
 * 会把 scheme 持久指向 node_modules 里的 Electron.app,跑过一次 dev 后打包版就收不到 co:// 深链。
 * dev 下验证深链用 second-instance argv / open-url 事件即可,不需要系统级注册。
 */
export function registerDefaultProtocolClient(
  app: { setAsDefaultProtocolClient(protocol: string): boolean },
  protocol: string,
  options: { defaultApp: boolean },
): void {
  if (options.defaultApp) return;
  app.setAsDefaultProtocolClient(protocol);
}
