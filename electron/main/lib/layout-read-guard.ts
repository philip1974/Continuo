// dock layout 持久化字节上限 + 读端守卫(单一来源)。
//
// 边界(E89):单窗口 dockview layout 序列化字节上限(远小于 explorer.json 16MiB E67 上限,确保写入后
// 整个 explorer.json 仍可读)。正常 layout 仅 KB 级,2MiB 留足余量。写端(layout:write)与读端
// (layout:read)共用此常量 —— ipc.ts 顶层有 app 副作用不可测试导入,故守卫逻辑抽到本可导入模块。
import { assertJsonValue } from '../../shared/assert-json-value';
import { utf8ByteLength } from '../../shared/utf8-byte-length';
import { jsonByteLowerBoundExceeds } from '../../shared/json-byte-budget';

export const MAX_LAYOUT_BYTES = 2 * 1024 * 1024;

/**
 * 边界(E215,E89 写端对偶):layout:read 读端守卫。持久化 layout 经写端 JSON-safe + 字节上限,但
 * 旧版本/手工污染的 explorer.json 可能含超大(2MiB+ 但 < 16MiB 文件上限,不被 loadExplorer 拒)的 dock
 * layout —— 读端此前直接 passthrough,renderer 恢复时仍 fromJSON() 处理 → 恢复卡顿/内存放大。读端复用
 * 写端同上限:超 MAX_LAYOUT_BYTES 或非 JSON-safe → 返 null(调用方走默认布局)。
 *
 * 注:disk layout 来自 loadExplorer 的 JSON.parse,本必 JSON-safe(JSON.parse 不产生 Infinity/NaN/
 * undefined),assertJsonValue 仅作极端损坏兜底;读端核心防护是**字节上限**(超大但合法 JSON 的 layout)。
 * 先 stringify 量字节并早拒(超限不再 assertJsonValue 递归),两者皆受 explorer.json 16MiB 上限封顶。
 */
export function sanitizeReadLayout(layout: unknown): unknown {
  if (layout === null || layout === undefined) return null;
  // 边界(E286,字节预算 fail-fast):字节下界 > 上限 ⇒ 必超限,在 JSON.stringify 物化巨字符串之前返 null
  //(超大但合法的 disk layout 直接走默认布局,不先 stringify 放大内存)。下界 ≤ 上限才走精确字节裁决。
  if (jsonByteLowerBoundExceeds(layout, MAX_LAYOUT_BYTES)) return null;
  const serialized = JSON.stringify(layout); // disk JSON 必可 stringify
  if (serialized === undefined) return null; // 极端:layout 不可序列化(理论上 disk 数据不会)
  if (utf8ByteLength(serialized) > MAX_LAYOUT_BYTES) return null;
  try {
    assertJsonValue(layout);
  } catch {
    return null;
  }
  return layout;
}
