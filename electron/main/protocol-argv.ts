// 从进程 argv 里提取自定义协议(co://)深链 URL。
//
// Windows/Linux 没有 macOS 的 open-url 事件:协议深链通过 argv 传入(冷启动 process.argv
// 或运行中 second-instance 的 argv)。此前用大小写敏感的 `a.startsWith('co://')` 前缀匹配:
//   - 大写 scheme(`CO://...`)被丢弃(URL scheme 大小写不敏感)→ 深链不派发;
// 这里用 `new URL()` 按 protocol 比较(大小写无关),兜底再做前缀匹配
// (跨平台审计 P2,主仓 index.ts:486 / 861)。

import { MAX_PROTOCOL_URL_LEN } from './protocol-dispatch';

function startsWithSchemeIgnoreCase(value: string, schemePrefix: string): boolean {
  if (value.length < schemePrefix.length) return false;
  for (let i = 0; i < schemePrefix.length; i += 1) {
    const a = value.charCodeAt(i);
    const b = schemePrefix.charCodeAt(i);
    if (a === b) continue;
    const folded = a >= 65 && a <= 90 ? a + 32 : a;
    if (folded !== b) return false;
  }
  return true;
}

function lowerIfNeeded(value: string): string {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code >= 65 && code <= 90) || code > 127) {
      return value.toLowerCase();
    }
  }
  return value;
}

/** 在 argv 中找第一个 `<protocol>://` 深链;无则 null。protocol 不含冒号(如 'co')。 */
export function extractProtocolUrl(
  argv: readonly string[],
  protocol: string,
): string | null {
  const scheme = `${lowerIfNeeded(protocol)}:`;
  const schemePrefix = `${scheme}//`;
  for (const a of argv) {
    if (typeof a !== 'string' || a.length === 0) continue;
    // 边界(E152):在 `new URL(a)` 解析与失败分支 `a.toLowerCase()` 拷贝之前先做长度上限。
    // 否则畸形/恶意超长 argv(冷启动 process.argv 或 second-instance argv)会在 routeProtocolUrl
    // 的 8KB 上限生效之前,先触发整串 URL 解析 + toLowerCase 大字符串拷贝 → 放大启动 CPU/内存。
    // 超 MAX_PROTOCOL_URL_LEN 的串即便是合法深链也会被下游 routeProtocolUrl 拒,故直接跳过无损。
    if (a.length > MAX_PROTOCOL_URL_LEN) continue;
    if (startsWithSchemeIgnoreCase(a, schemePrefix)) return a;
    try {
      if (lowerIfNeeded(new URL(a).protocol) === scheme) return a;
    } catch {
      // 非合法 URL:退回前缀匹配(大小写无关)
      // 常见 `<protocol>://` 已在上方无分配处理;这里保留 catch 形态以便未来 schemePrefix 规则扩展。
    }
  }
  return null;
}
