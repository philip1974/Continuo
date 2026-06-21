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

export class PluginMcpRegistry {
  private readonly entries = new Map<string, ToolEntry>();

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
    if (this.entries.has(spec.name)) {
      throw new PluginMcpError(
        PLUGIN_MCP_ERROR_CODES.TOOL_NAME_TAKEN,
        `plugin mcp tool name "${spec.name}" already registered in this renderer`,
      );
    }
    await this.upstream.register({
      pluginId,
      name: spec.name,
      description: spec.description,
      jsonSchema: spec.jsonSchema,
    });
    // upstream 成功才登本地表(失败路径不登 → 允许重试)。invoke 闭包捕获强类型 spec:
    // inputSchema.safeParse 得到的 parsed.data 即 I,spec.run(parsed.data) 在此处受 TS 检查。
    const invoke = async (input: unknown): Promise<unknown> => {
      const parsed = spec.inputSchema.safeParse(input);
      if (!parsed.success) {
        throw new PluginMcpError(
          PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
          parsed.error.issues.map((i) => i.message).join('; '),
        );
      }
      return await spec.run(parsed.data);
    };
    this.entries.set(spec.name, { invoke });

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.entries.delete(spec.name);
        // 异步 unregister(plugin disposable 模型是同步 dispose,
        // 但 IPC 必然异步;不 await,失败 console.warn)
        void this.upstream.unregister(spec.name).catch((err: unknown) => {
          console.warn(
            `[plugin-mcp-registry] unregister "${spec.name}" failed`,
            err,
          );
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
