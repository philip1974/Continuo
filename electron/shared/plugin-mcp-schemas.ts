// Plugin → MCP Bridge — IPC payload zod schemas。
//
// **改 schema 后必须同步更新 ./plugin-mcp-channels.ts 里手写的对应 type**
// (preload sandbox 不能 import zod,所以纯类型分文件留在 channels.ts)。
//
// 只在 main / renderer 进程使用(不被 preload 引用)。
//
// BDD: src/__tests__/plugin-mcp-ipc-bridge/

import { z } from 'zod';
import { assertJsonValue } from './assert-json-value';
import { utf8BytesExceed } from './utf8-byte-length';
import { jsonByteLowerBoundExceeds } from './json-byte-budget';
import { boundedValueDeepAdmissible } from './bounded-input';
import type { InvokeReply } from './plugin-mcp-channels';

// 边界(E17,E16 同族):plugin MCP REGISTER payload 的 pluginId/name/description/jsonSchema 此前无
// 长度/大小上限。jsonSchema 是任意对象、会被 main 存进 tool registry,之后每次 MCP tools/list 都把
// 它序列化广播给 HTTP/stdio 客户端 → 恶意/畸形插件注册超大 schema 造成内存/IPC/网络输出膨胀。
// 给名称/描述/pluginId 加长度上限;jsonSchema 加序列化字节上限(覆盖深度/属性数,序列化失败=非法)。
const PLUGIN_ID_MAX = 256;
// E53:name/description/jsonSchema 上限导出,供 renderer PluginMcpRegistry 发 IPC 前预检复用同值
//(main 的 RegisterPayloadSchema 在 structured-clone 进 main 后才校验,renderer 需同等前置防放大)。
export const TOOL_NAME_MAX = 256;
export const DESC_MAX = 8192;
export const SCHEMA_BYTES_MAX = 64 * 1024; // tool input schema 序列化后 ≤ 64KB
export const REQUEST_ID_MAX = 256;

/** renderer → main: 注册 tool 元数据(run 闭包不跨进程,留 renderer). */
export const RegisterPayloadSchema = z
  .object({
    pluginId: z.string().min(1).max(PLUGIN_ID_MAX),
    name: z.string().min(1).max(TOOL_NAME_MAX),
    description: z.string().max(DESC_MAX),
    /** 任意 JSON object,给 MCP client tools/list 看的 input schema. */
    // 边界(E188,E185-E187 同族):不用 z.record(z.unknown()).refine —— z.record 先 O(N) 全量遍历整个
    // schema 对象,assertJsonValue 的对象 key/字节上限(E184)来得太晚,巨 jsonSchema 在 schema 阶段就
    // O(N) 卡顿/分配。改 superRefine:先确认 plain object/非数组,再 assertJsonValue(E183/E184 已加数组
    // length + 对象 key 数早停上限)+ UTF-8 字节上限,去掉 z.record 的前置全量遍历。
    jsonSchema: z.custom<Record<string, unknown>>().superRefine((s, ctx) => {
      if (s === null || typeof s !== 'object' || Array.isArray(s)) {
        ctx.addIssue({ code: 'custom', message: 'jsonSchema 必须是对象' });
        return;
      }
      // 边界(E283,E259 / 校验顺序 fail-fast):assertJsonValue 早停上限是数组 1M / 对象 10万 key,远超
      // 64KiB schema 契约 → {enum: Array(1e6)} 会在字节上限前先递归遍历放大。先廉价递归 bounded 预检
      // (数组长/key 数/深度 fail-fast),挡住大遍历再 assertJsonValue + 字节上限。
      if (!boundedValueDeepAdmissible(s).ok) {
        ctx.addIssue({ code: 'custom', message: 'jsonSchema 过大或嵌套过深' });
        return;
      }
      // 边界(E307,E305/E306 reorder 同族 / 校验顺序 fail-fast):字节下界 fail-fast 在 assertJsonValue
      // 全量遍历之前(boundedValueDeepAdmissible 形态闸之后)—— 形态合法但「很多中等元素」的 schema 序列化
      // 字节可远超 64KiB,否则 assertJsonValue 先完整遍历(≤65536 元素)才被字节 cap 拒。jsonByteLowerBoundExceeds
      // 对任意输入安全(E288)可先于 assertJsonValue 跑。(仅「既非 JSON-safe 又超字节」病态 schema 的 issue
      // 文案从「非 JSON 安全值」变「序列化超过 N 字节」—— 两者皆 reject,单-bad 不变。)
      if (jsonByteLowerBoundExceeds(s, SCHEMA_BYTES_MAX)) {
        ctx.addIssue({
          code: 'custom',
          message: `jsonSchema 序列化超过 ${SCHEMA_BYTES_MAX} 字节`,
        });
        return;
      }
      try {
        // 边界(E105/E103):递归拒非 JSON 安全值(Infinity/NaN→null、丢 undefined/function),否则
        // tools/list 输出被静默改写,与插件注册 schema 不一致。E183/E184:数组/对象宽度早停上限。
        assertJsonValue(s);
        // 边界(E128,E125 同族):真实 UTF-8 字节(非 .length),否则含大量 CJK/emoji 的 schema 真实
        // 字节超 64KB 仍通过,放大 tools/list 广播。
        if (utf8BytesExceed(JSON.stringify(s), SCHEMA_BYTES_MAX)) {
          ctx.addIssue({
            code: 'custom',
            message: `jsonSchema 序列化超过 ${SCHEMA_BYTES_MAX} 字节`,
          });
        }
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'jsonSchema 非 JSON 安全值或循环引用',
        });
      }
    }),
  })
  .strict();

/** renderer → main: 摘掉 tool. */
export const UnregisterPayloadSchema = z
  .object({
    name: z.string().min(1).max(TOOL_NAME_MAX),
  })
  .strict();

/** main → renderer: 反向调用 tool.run. */
export const InvokePayloadSchema = z
  .object({
    requestId: z.string().min(1).max(REQUEST_ID_MAX),
    name: z.string().min(1).max(TOOL_NAME_MAX),
    /**
     * plugin 自定义 inputSchema,bridge 层不预设形态 — 任意值都接受,
     * 但 key 必须存在(zod 的 z.unknown 会把缺 key 算 optional,refine 兜住).
     */
    input: z.unknown(),
  })
  .strict()
  .refine((data) => 'input' in data, {
    message: 'input is required',
    path: ['input'],
  });

// 边界(E19,E17 同族):InvokeReply 的 result/code/message 此前无上限。result: z.unknown() 通过后
// 被 mcp-host 在 tools/call 路径 JSON.stringify(result) 输出给 HTTP/stdio 客户端 → 畸形/恶意插件单次
// 回传超大对象/字符串造成主进程内存峰值、IPC/MCP 响应膨胀甚至卡死。result 加可序列化 + 序列化字节
// 上限;requestId/code/message 加长度上限。超限 → 校验失败(reply 被拒,不转发给客户端)。
const CODE_MAX = 256;
const MESSAGE_MAX = 8192;
export const RESULT_BYTES_MAX = 10 * 1024 * 1024; // tool result 序列化后 ≤ 10MB

/**
 * 边界(E19/E117/E128 + E262):invoke result 是否可作为成功结果回传 —— 必 JSON 安全(assertJsonValue
 * 递归拒 Infinity/NaN/undefined 属性/function/循环引用,JSON.stringify 不是「可序列化」校验)且序列化
 * UTF-8 字节 ≤ RESULT_BYTES_MAX(真实字节非 UTF-16 code unit)。top-level undefined = 空结果显式放行。
 *
 * **单一来源**:InvokeReplySchema 的 result refine(main 侧)与 renderer invoke bridge(E262,发 IPC 前
 * 预检,避免「校验太晚」—— 结果先经 preload→main structured-clone IPC 再在 main 校验,超大结果已放大
 * 内存/卡顿)共用此函数。
 */
export function isInvokeResultAdmissible(r: unknown): boolean {
  try {
    if (r === undefined) return true;
    // 边界(E305,E283 校验顺序 fail-fast):先廉价字节下界 fail-fast(早停于 RESULT_BYTES_MAX)再
    // assertJsonValue 全量遍历 —— 否则超 10MiB 但 shape 合法(≤assertJsonValue 1M/10万/256 上限)的 result
    // 会被 assertJsonValue 完整遍历后才被字节 cap 拒。jsonByteLowerBoundExceeds 对任意输入安全(E288),可在
    // assertJsonValue 前运行。**行为保持**(超限两序皆 false;非 JSON-safe 仍由其后 assertJsonValue 拒)——
    // 不用 codex 建议的 boundedValueDeepAdmissible(那会把 accept set 收紧:深度 256→64 / 数组 1M→65536,
    // 误拒当前合法的深/大 result),reorder 既 fail-fast 又不改判定。
    if (jsonByteLowerBoundExceeds(r, RESULT_BYTES_MAX)) return false;
    // 边界(E286):字节下界 ≤ 上限后,assertJsonValue 拒非 JSON 安全值 + 形态早停,再精确字节 cap(转义后
    // 真实字节可能 > 下界)。
    assertJsonValue(r);
    return !utf8BytesExceed(JSON.stringify(r), RESULT_BYTES_MAX);
  } catch {
    return false; // 非 JSON 安全值 / 循环引用 → 非法
  }
}

/** renderer → main: invoke 答复(discriminated union by ok). */
export const InvokeReplySchema = z.discriminatedUnion('ok', [
  z
    .object({
      requestId: z.string().min(1).max(REQUEST_ID_MAX),
      ok: z.literal(true),
      result: z.unknown().refine(isInvokeResultAdmissible, {
        message: `result 非 JSON 安全值、循环引用或序列化超过 ${RESULT_BYTES_MAX} 字节`,
      }),
    })
    .strict(),
  z
    .object({
      requestId: z.string().min(1).max(REQUEST_ID_MAX),
      ok: z.literal(false),
      code: z.string().min(1).max(CODE_MAX),
      message: z.string().max(MESSAGE_MAX),
    })
    .strict(),
]);

/**
 * 边界(E263,E262 兄弟 / 校验太晚):构造长度合规的 ok:false InvokeReply —— code≤CODE_MAX /
 * message≤MESSAGE_MAX,与 InvokeReplySchema 上限**同源**。renderer bridge catch 分支发 IPC 前用此裁剪
 * 插件抛出的 err.code/err.message —— E262 只修了 ok:true result,catch 分支仍把 err.code/message 原样
 * replyInvoke,而 code/message 上限在 main 侧、preload→main IPC 之后才生效(超长错误串先跨 IPC 放大)。
 * requestId 已由上游 InvokePayloadSchema 限长,此处不再裁剪。
 */
export function makeInvokeErrorReply(
  requestId: string,
  code: string,
  message: string,
): InvokeReply {
  return {
    requestId,
    ok: false,
    code: code.length > CODE_MAX ? code.slice(0, CODE_MAX) : code,
    message:
      message.length > MESSAGE_MAX ? message.slice(0, MESSAGE_MAX) : message,
  };
}
