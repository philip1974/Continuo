// PluginMcpRegistry — renderer 侧 MCP tool 本地表 + 上行 IPC 适配。
//
// run 闭包跨不了进程,因此分两层:
//   - 本 registry(renderer)留 spec.run + spec.inputSchema,name → spec 表
//   - 上行 IPC(注入 PluginMcpUpstream)只送 name / description / jsonSchema 元数据给 main
//   - main 反向调用走 invokeLocal(name, input) 派发本地 run
//
// BDD: src/__tests__/plugin-mcp-registry/

import type { z } from 'zod';
import type { Disposable } from '../types';
import { PLUGIN_MCP_ERROR_CODES } from '../../../electron/shared/plugin-mcp-channels';
import { capJoinedMessagesFrom } from '../../../electron/shared/cap-joined-messages';
import { assertJsonValue } from '../../../electron/shared/assert-json-value';
import { boundedValueDeepAdmissible } from '../../../electron/shared/bounded-input';
import { jsonByteLowerBoundExceeds } from '../../../electron/shared/json-byte-budget';
import { isSpecObject } from './spec-guard';
import { utf8BytesExceed } from '../../../electron/shared/utf8-byte-length';
import {
  TOOL_NAME_MAX,
  DESC_MAX,
  SCHEMA_BYTES_MAX,
} from '../../../electron/shared/plugin-mcp-schemas';

export type { Disposable };

// ── tool spec(plugin 上送的) ──────────────────────────────────

export interface PluginMcpToolSpec<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  /** 给 LLM / MCP client tools/list 看的 JSON Schema(plugin 手填字面量). */
  readonly jsonSchema: Record<string, unknown>;
  /** 本地校验 input 用的 zod schema. */
  readonly inputSchema: z.ZodType<I>;
  readonly run: (input: I) => O | Promise<O>;
}

// ── 上行 IPC 适配 ──────────────────────────────────────────────

export interface PluginMcpUpstreamRegisterPayload {
  readonly pluginId: string;
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: Record<string, unknown>;
}

export interface PluginMcpUpstream {
  /** main 侧若已存同名 tool → reject(message + code TOOL_NAME_TAKEN). */
  register(p: PluginMcpUpstreamRegisterPayload): Promise<void>;
  /** unknown name 静默忽略由 main 端实装. */
  unregister(name: string): Promise<void>;
}

// ── error 类 ──────────────────────────────────────────────────

export { PLUGIN_MCP_ERROR_CODES };

export class PluginMcpError extends Error {
  override name = 'PluginMcpError' as const;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ── Registry ─────────────────────────────────────────────────

// 可维护性 M17:内部 Map 存非泛型 entry 闭包(invoke)。各 spec 的 inputSchema<I> ↔
// run(I) 泛型配对关系留在 register<I,O> 作用域内被 TS 检查,不再 `spec as unknown as
// AnyToolSpec` 双重断言擦除泛型(那会绕过 run 的参数类型检查)。
interface ToolEntry {
  /** 据 inputSchema 校验 input 后调本 spec 的 run;泛型已在 register 闭包内绑定. */
  readonly invoke: (input: unknown) => Promise<unknown>;
}

// 边界(E53,E17 renderer 侧对偶 / E43-E46 同族):register 把 name/description/jsonSchema 直接
// upstream.register(...) 发 IPC,main 的 RegisterPayloadSchema 虽有上限(E17:name≤256/desc≤8192/
// jsonSchema≤64KB),但校验发生在 structured-clone 进 main 之后。畸形插件传超大 jsonSchema/描述会先
// 卡 renderer/preload→main IPC + 内存,main 上限太晚。发 IPC 前用同等上限(shared 常量)本地预检:
// 超限抛 INVALID_PARAMS,不发 IPC、不写本地 entry。也校验 run/inputSchema 为可调用(非函数 invoke 期才崩)。
function validateToolSpec<I, O>(spec: PluginMcpToolSpec<I, O>): void {
  const bad = (msg: string): never => {
    throw new PluginMcpError(PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS, msg);
  };
  // 边界(E273,E271 registry 族):先校验 spec 是对象,否则读 spec.name 对 null/undefined 抛 TypeError。
  if (!isSpecObject(spec)) bad('tool spec must be an object');
  if (typeof spec.name !== 'string' || spec.name.length === 0 || spec.name.length > TOOL_NAME_MAX)
    bad(`invalid tool name (empty or > ${TOOL_NAME_MAX})`);
  if (typeof spec.description !== 'string' || spec.description.length > DESC_MAX)
    bad(`invalid description (not string or > ${DESC_MAX})`);
  if (typeof spec.run !== 'function') bad('run must be a function');
  if (
    spec.inputSchema === null ||
    typeof spec.inputSchema !== 'object' ||
    typeof (spec.inputSchema as { safeParse?: unknown }).safeParse !== 'function'
  )
    bad('inputSchema must be a zod schema (safeParse)');
  // jsonSchema:必须是纯 JSON object(非 null/数组)+ JSON 安全值 + 字节 ≤ 上限(同 main refine,
  // 发 IPC 前先做)。边界(E105,同 E103):JSON.stringify 不是「可序列化」校验 —— 它静默把
  // Infinity/NaN→null、丢 undefined/function 属性(只对循环引用才抛)。插件可注册一个表面成功但
  // 输出被静默改写的 inputSchema,tools/list 中 schema 与插件自认为的不一致 → LLM/client 按错误
  // schema 调 tool。先 assertJsonValue 递归拒非 JSON 安全值,再 stringify + 字节上限。
  if (
    spec.jsonSchema === null ||
    typeof spec.jsonSchema !== 'object' ||
    Array.isArray(spec.jsonSchema)
  )
    bad('jsonSchema must be a plain JSON object');
  // 边界(E283,E259 / 校验顺序 fail-fast):先做廉价递归 bounded 预检(数组长/对象 key 数/深度,fail-fast
  // 不遍历)再 assertJsonValue + 字节上限。assertJsonValue 的早停上限是数组 1M / 对象 10万 key,远超 64KiB
  // schema 契约 → {enum: Array(1e6)} 会在被字节上限拒绝前先递归遍历 1M 项 + stringify 巨对象放大。
  // boundedValueDeepAdmissible 在数组长度处 O(1) fail-fast,挡住大遍历。
  if (!boundedValueDeepAdmissible(spec.jsonSchema).ok)
    bad('jsonSchema too large or deeply nested');
  // 边界(E308,E305-E307 reorder 同族 / 校验顺序 fail-fast):字节下界 fail-fast 在 assertJsonValue 全量
  // 遍历之前(boundedValueDeepAdmissible 形态闸之后)—— 形态合法但「很多中等元素」且 >64KiB 的 schema 不被
  // assertJsonValue 完整遍历后才拒(E289 原序 assertJsonValue→byte;统一到 reorder 族:byte→assertJsonValue)。
  // jsonByteLowerBoundExceeds 对任意输入安全(E288)可先跑。与 main RegisterPayloadSchema(E286/E307)同序。
  if (jsonByteLowerBoundExceeds(spec.jsonSchema, SCHEMA_BYTES_MAX))
    bad(`jsonSchema exceeds ${SCHEMA_BYTES_MAX} bytes`);
  try {
    assertJsonValue(spec.jsonSchema);
  } catch {
    bad('jsonSchema contains non-JSON values (NaN/Infinity/undefined/function)');
  }
  // 边界(E130,E128 的 renderer 预检对偶):按真实 UTF-8 字节(非 .length=UTF-16 code unit),与
  // main RegisterPayloadSchema 完全一致 —— 否则 renderer 误放行 CJK/emoji 大 schema,仍先 stringify
  // + IPC/structured-clone 到 main(main E128 才拒),违背「发 IPC 前预检防放大」契约。
  const serialized = JSON.stringify(spec.jsonSchema);
  if (utf8BytesExceed(serialized, SCHEMA_BYTES_MAX))
    bad(`jsonSchema exceeds ${SCHEMA_BYTES_MAX} bytes`);
}

export class PluginMcpRegistry {
  private readonly entries = new Map<string, ToolEntry>();
  // race(R74):按 tool name 记录在途的 unregister promise。dispose 是同步的(plugin Disposable
  // 模型),但 unregister IPC 必然异步;若紧接着 register 同名 tool(reload/disable→enable),
  // register IPC 可能先于 unregister 到 main → main 仍持旧 tool → 返回 TOOL_NAME_TAKEN。
  // register 注册前先 await 同名在途 unregister,保证 main 已移除旧 tool 再注册。
  private readonly pendingUnregister = new Map<string, Promise<void>>();

  constructor(private readonly upstream: PluginMcpUpstream) {}

  /**
   * 注册 plugin 的 tool。失败路径:
   * - 本 renderer 内重名 → 抛 TOOL_NAME_TAKEN(不发 IPC)
   * - upstream.register reject → 透传(本地表不登,可重试)
   *
   * 成功 → resolve Disposable;Disposable.dispose 调 upstream.unregister 一次,
   * 多次 dispose 幂等。
   */
  async register<I, O>(
    spec: PluginMcpToolSpec<I, O>,
    pluginId: string,
  ): Promise<Disposable> {
    validateToolSpec(spec); // 边界(E53):发 IPC/写本地 entry 前预检 name/description/jsonSchema/run/inputSchema
    if (this.entries.has(spec.name)) {
      throw new PluginMcpError(
        PLUGIN_MCP_ERROR_CODES.TOOL_NAME_TAKEN,
        `plugin mcp tool name "${spec.name}" already registered in this renderer`,
      );
    }
    // race(R74):若同名 tool 刚被 dispose 且 unregister IPC 仍在途,先等它完成再 register,
    // 否则 register 可能先到 main → main 仍持旧 tool → TOOL_NAME_TAKEN(reload 后注册失败/
    // 残留旧 stub)。pending promise 已 catch 过 unregister 失败(resolve void),await 不抛。
    const pendingUnreg = this.pendingUnregister.get(spec.name);
    if (pendingUnreg) await pendingUnreg;
    // race(R95):await pendingUnregister 后**重新检查**同名占用。两个并发同名 register 都过了上面
    // 的首次 has() 检查(此刻谁都没 set),await 同一个 pending unregister 后会同时继续;若不复查,
    // 二者都 entries.set + 并发 upstream.register,失败者的 catch entries.delete(R86 回滚)会删掉
    // 成功者刚写入的本地 entry → 外部 tools/call 得 NO_SUCH_TOOL。复查后:先恢复者 set entry(下方
    // 同步、无 await),后恢复者在此命中 has() → 抛 TOOL_NAME_TAKEN,只一个进入注册流程。
    if (this.entries.has(spec.name)) {
      throw new PluginMcpError(
        PLUGIN_MCP_ERROR_CODES.TOOL_NAME_TAKEN,
        `plugin mcp tool name "${spec.name}" already registered in this renderer`,
      );
    }
    // invoke 闭包捕获强类型 spec:inputSchema.safeParse 得到的 parsed.data 即 I,
    // spec.run(parsed.data) 在此处受 TS 检查。
    const invoke = async (input: unknown): Promise<unknown> => {
      // 边界(E259,E255-E258 深化 / schema-阶段放大):main 侧 E255 只预检 arguments **顶层** key,
      // 但 plugin 自定义 inputSchema 可为**嵌套** `.strict()` object —— `{a:{<<海量 key>>}}` 顶层 1 key
      // 绕过 main 顶层闸,在此处 safeParse 递归枚举内层 key 触发 Zod issue 构造放大(renderer CPU/内存
      // /UI 卡顿 + 拖到 main pending 超时)。safeParse 前做**递归** bounded 预检(嵌套 key 数/key 长/
      // 数组长/深度),超限直接 INVALID_PARAMS 不进 plugin schema。
      const bounded = boundedValueDeepAdmissible(input);
      if (!bounded.ok) {
        throw new PluginMcpError(
          PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
          `invalid params: input exceeds bounds (${bounded.reason})`,
        );
      }
      const parsed = spec.inputSchema.safeParse(input);
      if (!parsed.success) {
        throw new PluginMcpError(
          PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
          // 边界(E76,E73/E75 跨进程同族):外部 MCP client 传畸形 arguments 时,issues 无界
          // map+join 会构造超长错误串经 reply schema/IPC/日志放大。复用共享 capJoinedMessages
          // 限条数 + 总长(与 main 侧 formatZodErrorCapped 同一来源)。
          // 边界(E223,E222 兄弟):mapper 变体,只对前 N 个 issue 取 .message,不先 issues.map 全量物化。
          capJoinedMessagesFrom(
            parsed.error.issues,
            (i) => i.message,
            'more issues',
          ),
        );
      }
      return await spec.run(parsed.data);
    };
    // race(R86):先登记本地可执行 entry,再 await upstream.register 把 tool 暴露给 main。此前顺序
    // 相反(先 await upstream.register,resolve 后才 entries.set):main 一旦完成 register 就可能
    // 被外部 MCP client 立即 tools/call,而此调用若早于 renderer 的 await continuation 写入
    // entries,invokeLocal 命中 NO_SUCH_TOOL = "刚注册成功但首次调用失败"。本地 entry 先就位,
    // upstream.register resolve 时本地表已可执行。upstream 失败回滚本地 entry,保持"失败不残留
    // 本地表、允许重试"语义(原 line 107 注释承诺)。
    this.entries.set(spec.name, { invoke });
    try {
      await this.upstream.register({
        pluginId,
        name: spec.name,
        description: spec.description,
        jsonSchema: spec.jsonSchema,
      });
    } catch (err) {
      this.entries.delete(spec.name); // 回滚:upstream 失败不在本地残留,允许重试
      throw err;
    }

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.entries.delete(spec.name);
        // 异步 unregister(plugin disposable 模型是同步 dispose,但 IPC 必然异步;不 await,
        // 失败 console.warn)。race(R74):把该 promise 记进 pendingUnregister,供后续同名
        // register await,保证「先 unregister 落地、再 register」的顺序。catch 后 resolve void,
        // 故 register 端 await 不会抛。settle 后清表(仅当仍是本 promise,避免清掉后继 dispose 的)。
        const unregP = this.upstream
          .unregister(spec.name)
          .catch((err: unknown) => {
            console.warn(
              `[plugin-mcp-registry] unregister "${spec.name}" failed`,
              err,
            );
          });
        this.pendingUnregister.set(spec.name, unregP);
        void unregP.finally(() => {
          if (this.pendingUnregister.get(spec.name) === unregP) {
            this.pendingUnregister.delete(spec.name);
          }
        });
      },
    };
  }

  /**
   * main 反向调用入口:据 name 取 spec,校 input,调 run。
   * - 未注册 / 已 dispose → reject NO_SUCH_TOOL
   * - inputSchema 校验失败 → reject INVALID_PARAMS(message 拼 zod issues)
   * - run 抛错 → reject 透传(原对象,含 code 也带过去)
   */
  async invokeLocal(name: string, input: unknown): Promise<unknown> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new PluginMcpError(
        PLUGIN_MCP_ERROR_CODES.NO_SUCH_TOOL,
        `plugin mcp tool not found: ${name}`,
      );
    }
    return await entry.invoke(input);
  }
}
