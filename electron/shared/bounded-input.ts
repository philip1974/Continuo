// 边界(E255/E256/E257 同族 —— schema-阶段放大):不可信外部数据交给 zod `.strict()` safeParse 前,
// 须先做廉价 bounded 预检 —— `.strict()` 对 unrecognized_keys 是 O(keys) 枚举 + 逐 key 构造 issue/
// message,错误串 cap(formatZodErrorCapped)在 parse **之后**才生效,挡不住 parse 内部 CPU/内存放大。
// 此 helper 是三处入口(MCP tools/call=E255 / 通用 safeHandle=E256 / plugin-mcp reply=E257)共享的
// **单一逻辑来源**(收口消漂移):只对 plain object 检自有 key 数与单 key 长度;非 plain object
// (string/number/array/原始值,均为合法 schema 输入)放行,交给 schema 自身校验。
//
// 跨进程单一来源放 electron/shared(renderer 不可 import main;main 各 service/ipc 共用同一份)。
// 值远超任何真实 IPC/MCP 入参形态(字段数 / 字段名长度)。

export const MAX_BOUNDED_OBJECT_KEYS = 1024;
export const MAX_BOUNDED_OBJECT_KEY_LEN = 8192;

export type BoundedReason = 'too-many-keys' | 'key-too-long';

/**
 * 边界(E255/E256/E257):plain object 的 bounded 准入判定(纯函数,便于测试)。在 safeParse 前调用。
 * 仅对 plain object 检自有 key 数量与单 key 长度;非 plain object 直接放行({ok:true})。
 * 失败时返回结构化 reason,由各调用点映射成自己的领域错误文案(保持各入口既有契约)。
 */
export function boundedObjectAdmissible(
  rawInput: unknown,
): { ok: true } | { ok: false; reason: BoundedReason } {
  if (
    rawInput === null ||
    typeof rawInput !== 'object' ||
    Array.isArray(rawInput)
  ) {
    return { ok: true };
  }
  // 边界(E300,E184 同款「校验前勿全量物化 key 数组」):此前 Object.keys() 先把全部 key 物化成数组再
  // 判数量 —— preflight 本应廉价,百万-key payload 会先分配百万元素数组才 reject。改 for...in + hasOwnProperty
  // 边数边查 + 早停(超 MAX_BOUNDED_OBJECT_KEYS 立即返回,不再遍历)。for...in 仅枚举可枚举 string key
  //(与 Object.keys / zod .strict() 枚举语义一致;此 helper 是纯数量/长度闸,无 E140/E200 的 symbol/非枚举
  // 检测需求,故不同于 assert-json-value 必须 Reflect.ownKeys 的 E221 决策)。
  const obj = rawInput as Record<string, unknown>;
  let count = 0;
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    count += 1;
    if (count > MAX_BOUNDED_OBJECT_KEYS) {
      return { ok: false, reason: 'too-many-keys' };
    }
    if (k.length > MAX_BOUNDED_OBJECT_KEY_LEN) {
      return { ok: false, reason: 'key-too-long' };
    }
  }
  return { ok: true };
}

// 边界(E259,E255-E258 深化):顶层 boundedObjectAdmissible 只检 plain object 的**顶层** key —— 嵌套
// 对象/数组里的海量未知 key 不受限。当 safeParse 的 schema 会**递归**枚举(plugin 自定义 `.strict()`
// 嵌套 schema)时,`{a:{<<10万 key>>}}` 顶层只 1 key 可绕过顶层闸,递归到内层仍触发 Zod 枚举/构造
// issue 放大。`boundedValueDeepAdmissible` 递归限制:每对象 key 数、单 key 长、数组长度、嵌套深度。
// 递归带 depth 计数并在超 MAX_BOUNDED_DEPTH 时**先于继续递归**返回(故本函数自身递归深度有界,不会因
// 病态深嵌套先爆栈)。失败 fail-fast。用于无 body 字节闸兜底的 schema 入口(renderer 反向 invoke)。
export const MAX_BOUNDED_DEPTH = 64; // 嵌套深度上限(远超任何真实 tool 入参嵌套)
export const MAX_BOUNDED_ARRAY_LEN = 65_536; // 数组长度上限(比对象 key 上限宽,真实 tool 列表可较长)

export type BoundedDeepReason =
  | 'too-many-keys'
  | 'key-too-long'
  | 'array-too-long'
  | 'too-deep';

export function boundedValueDeepAdmissible(
  value: unknown,
  depth = 0,
): { ok: true } | { ok: false; reason: BoundedDeepReason } {
  if (depth > MAX_BOUNDED_DEPTH) {
    return { ok: false, reason: 'too-deep' };
  }
  if (value === null || typeof value !== 'object') {
    return { ok: true };
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_BOUNDED_ARRAY_LEN) {
      return { ok: false, reason: 'array-too-long' };
    }
    for (let i = 0; i < value.length; i += 1) {
      const r = boundedValueDeepAdmissible(value[i], depth + 1);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  // 边界(E300,同 boundedObjectAdmissible):for...in + hasOwnProperty 边数边查 + 早停,不先 Object.keys
  // 全量物化 key 数组(深层海量 key 对象在判数量前先分配巨数组)。
  const obj = value as Record<string, unknown>;
  let count = 0;
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    count += 1;
    if (count > MAX_BOUNDED_OBJECT_KEYS) {
      return { ok: false, reason: 'too-many-keys' };
    }
    if (k.length > MAX_BOUNDED_OBJECT_KEY_LEN) {
      return { ok: false, reason: 'key-too-long' };
    }
    const r = boundedValueDeepAdmissible(obj[k], depth + 1);
    if (!r.ok) return r;
  }
  return { ok: true };
}
