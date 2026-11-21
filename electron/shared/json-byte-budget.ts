// 边界(E286,E283/E285「stringify 前 fail-fast」族 —— 字节预算维度):多处入口用
// `JSON.stringify(x)` → `utf8BytesExceed(serialized, CAP)` 校验序列化字节上限(部分入口前置 assertJsonValue)。
// assertJsonValue 只限**形态**(数组 1M / 对象 10万 key / key 长 8192 / string 值 16MiB E285 / 深度 256),
// 远超各调用方的字节 CAP(RESULT_BYTES_MAX 10MiB / SCHEMA_BYTES_MAX 64KiB / MAX_PLUGIN_DATA_BYTES 16MiB /
// MAX_LAYOUT_BYTES 2MiB)。形态合法但「很多中等元素」(如 100 万元素数组、每个中等字符串)的序列化字节
// 可远超 CAP —— 而字节上限是在 `JSON.stringify` **之后**才裁决,那个 stringify 已先把巨大字符串物化
//(stringify 本身=OOM 点)。
//
// 本 helper 在 stringify **之前**对序列化字节数做**下界**估算并提前短路:下界 > CAP ⇒ 真实字节必 > CAP
//(下界永不高估)⇒ 可安全拒绝,且**不改变 accept/reject 判定**(只是对会被字节 CAP 拒的病态输入更早、
// 更省地拒,合法输入下界 ≤ CAP 时照常走其后的精确 stringify 裁决)。下界永不误伤字节 CAP 会接受的输入。
//
// 跨进程单一来源放 electron/shared(renderer 不可 import main;main 各 service/ipc 共用同一份)。
//
// **对任意输入安全**(E288,host 通用边界无前置 assertJsonValue):精确复刻 JSON.stringify 的省略/强转语义
// 以保持「下界永不高估」:非有限 number → "null"(4);数组里的 undefined/function/symbol → "null"(4);
// 对象里值为 undefined/function/symbol 的成员被**整段省略**(不计 key 也不计逗号);bigint 计 0(stringify
// 将抛错,本 helper 不据此拒,交由调用方 stringify 抛);循环引用经深度上限保守判超限。本 helper **绝不抛错**。

import { utf8ByteLength } from './utf8-byte-length';

// 与 assert-json-value 的 MAX_JSON_DEPTH 对齐(allow ≤ 256;>256 已被 assertJsonValue 抛/或循环引用,
// 保守判为超限,避免无限递归)。
const MAX_JSON_BUDGET_DEPTH = 256;

// 共享下界遍历(strLen 决定字符串长度度量:UTF-8 字节 vs UTF-16 .length)。strLen 同时用于字符串**值**与
// 对象 key —— 二者在 JSON 输出里都是字符串。number/bool/null/结构字符均 ASCII,两度量相同,故只 strLen 变化。
function lowerBoundExceeds(
  value: unknown,
  limit: number,
  strLen: (s: string) => number,
): boolean {
  let acc = 0;
  let exceeded = false;

  const add = (n: number): void => {
    acc += n;
    if (acc > limit) exceeded = true;
  };

  // v 作为「会被 JSON.stringify 输出成一个值」的位置(top-level / 数组元素)计下界:
  // 此位置 undefined/function/symbol → JSON 输出 "null"(4)。
  const walkValue = (v: unknown, depth: number): void => {
    if (exceeded) return;
    if (depth > MAX_JSON_BUDGET_DEPTH) {
      exceeded = true; // 循环引用 / 病态深嵌套:保守拒。
      return;
    }
    if (v === null) {
      add(4); // "null"
      return;
    }
    const t = typeof v;
    if (t === 'boolean') {
      add(v ? 4 : 5); // "true" / "false"
      return;
    }
    if (t === 'number') {
      // 有限 number 的 JSON 序列化 == String(n)(纯 ASCII);非有限 → "null"(4)。两者皆精确,亦为合法下界。
      add(Number.isFinite(v as number) ? String(v).length : 4);
      return;
    }
    if (t === 'string') {
      // 下界:两个引号 + 原始字符串长度度量(转义只会**增加**长度,故 undercount 安全)。
      add(2 + strLen(v as string));
      return;
    }
    if (t === 'undefined' || t === 'function' || t === 'symbol') {
      // 此位置(top-level / 数组元素)JSON 输出 "null"(top-level 实为 undefined→调用方 '' 兜底,
      // 计 4 仍是安全下界,不会误判超限)。
      add(4);
      return;
    }
    if (t === 'bigint') {
      add(0); // JSON.stringify 将抛错;本 helper 不据此拒,计 0(下界),交调用方 stringify 抛。
      return;
    }
    if (Array.isArray(v)) {
      add(2); // [ ]
      if (v.length > 1) add(v.length - 1); // 元素间逗号(数组元素从不省略 → 精确,亦为下界)
      for (let i = 0; i < v.length; i += 1) {
        if (exceeded) return;
        walkValue(v[i], depth + 1);
      }
      return;
    }
    // object(plain 或其它):for...in + hasOwnProperty 枚举自有可枚举 string key(与 Object.keys /
    // JSON.stringify 一致),边走边算 + exceeded 早停,**不先 Object.keys 全量物化 key 数组**(E300 同款 —— 本
    // helper 是 fail-fast OOM 守卫,物化 key 数组自相矛盾;百万-key 对象在 budget 超限前先分配巨数组)。
    const obj = v as Record<string, unknown>;
    add(2); // { }
    let emitted = 0;
    for (const k in obj) {
      if (exceeded) return;
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      const cv = obj[k];
      const ct = typeof cv;
      // JSON.stringify 省略值为 undefined/function/symbol 的成员(key、值、逗号均不输出)。
      if (cv === undefined || ct === 'function' || ct === 'symbol') continue;
      if (emitted > 0) add(1); // 已输出成员之间的逗号
      add(2 + strLen(k) + 1); // "key":
      walkValue(cv, depth + 1);
      emitted += 1;
    }
  };

  walkValue(value, 0);
  return exceeded;
}

/**
 * JSON.stringify(value) 的 UTF-8 字节数**下界**是否 > limit(带短路,不物化序列化字符串)。
 * 返回 true ⇒ 真实序列化字节必 > limit。返回 false ⇒ 下界 ≤ limit(需调用方其后用精确 stringify 裁决)。
 * 对任意输入安全(绝不抛错),并对 JSON.stringify 的省略/强转语义保持合法下界。
 */
export function jsonByteLowerBoundExceeds(value: unknown, limit: number): boolean {
  return lowerBoundExceeds(value, limit, utf8ByteLength);
}

/**
 * 边界(E309):JSON.stringify(value)**.length**(UTF-16 code unit)下界是否 > limit。用于按 `.length` 限的
 * cap(localStorage writeRecord/readRecord 对原始串 .length 设上限,非 UTF-8 字节)—— jsonByteLowerBoundExceeds
 * 是 UTF-8 字节(≥ .length),对 .length cap 会误拒 CJK 记录,故单独提供 .length 度量。返回 true ⇒ 真实
 * 序列化 .length 必 > limit。对任意输入安全。
 */
export function jsonStringLengthLowerBoundExceeds(
  value: unknown,
  limit: number,
): boolean {
  return lowerBoundExceeds(value, limit, (s) => s.length);
}
