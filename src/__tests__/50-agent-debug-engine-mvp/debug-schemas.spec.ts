import { describe, expect, it } from 'vitest';

import {
  debugDisconnectInputJsonSchema,
  debugDisconnectInputSchema,
  debugEvaluateInputJsonSchema,
  debugLaunchInputJsonSchema,
  debugListSessionsInputJsonSchema,
  debugScopesInputJsonSchema,
  debugSetBreakpointInputJsonSchema,
  debugStackInputJsonSchema,
  debugThreadControlInputJsonSchema,
  debugVariablesInputJsonSchema,
  debugWaitForStopInputJsonSchema,
  debugEvaluateInputSchema,
  debugSetBreakpointInputSchema,
  debugVariablesInputSchema,
} from '../../../electron/shared/mcp-debug-schemas';
import { SESSION_ID_MAX } from '../../../electron/shared/session-id-limits';

function collectObjectSchemas(schema: unknown, out: unknown[] = []): unknown[] {
  if (!schema || typeof schema !== 'object') return out;
  const record = schema as Record<string, unknown>;
  if (record.type === 'object') out.push(record);
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) collectObjectSchemas(item, out);
    } else {
      collectObjectSchemas(value, out);
    }
  }
  return out;
}

/** 对外广播的全部入参 JSON schema(MCP tools/list 的 inputSchema;工具输出没有 schema)。 */
const ADVERTISED_INPUT_SCHEMAS = [
  debugLaunchInputJsonSchema,
  debugSetBreakpointInputJsonSchema,
  debugWaitForStopInputJsonSchema,
  debugThreadControlInputJsonSchema,
  debugStackInputJsonSchema,
  debugScopesInputJsonSchema,
  debugVariablesInputJsonSchema,
  debugEvaluateInputJsonSchema,
  debugDisconnectInputJsonSchema,
  debugListSessionsInputJsonSchema,
];

type JsonProps = Record<string, Record<string, unknown>>;
const propsOf = (schema: unknown): JsonProps => (schema as { properties: JsonProps }).properties;

describe('50 · debug_* schemas', () => {
  it('所有 advertised object schema 都关闭 additionalProperties', () => {
    for (const inputJsonSchema of ADVERTISED_INPUT_SCHEMAS) {
      const objectSchemas = collectObjectSchemas(inputJsonSchema);
      expect(objectSchemas.length).toBeGreaterThan(0);
      for (const objectSchema of objectSchemas) {
        expect((objectSchema as Record<string, unknown>).additionalProperties).toBe(
          false,
        );
      }
    }
  });

  // 对外 JSON schema 从 zod 派生(z.toJSONSchema io:'input'),不再手写双份 —— 手写版曾漏 minLength
  // (空串 session_id / 路径 / expression 对外合法、运行时 INVALID_PARAMS)与 evaluate frame_id 下界不一致。
  it('advertised session_id / 路径 / expression 声明 minLength 1 与上限,与运行时 zod 一致', () => {
    for (const inputJsonSchema of ADVERTISED_INPUT_SCHEMAS) {
      const sessionId = propsOf(inputJsonSchema).session_id;
      if (sessionId === undefined) continue;
      expect(sessionId).toMatchObject({ type: 'string', minLength: 1, maxLength: SESSION_ID_MAX });
    }
    expect(propsOf(debugLaunchInputJsonSchema).program).toMatchObject({ minLength: 1 });
    expect(propsOf(debugSetBreakpointInputJsonSchema).file).toMatchObject({ minLength: 1 });
    expect(propsOf(debugEvaluateInputJsonSchema).expression).toMatchObject({ minLength: 1 });
    expect(debugEvaluateInputSchema.safeParse({ session_id: '', expression: 'x' }).success).toBe(false);
  });

  it('evaluate 的 frame_id 是非负整数:运行时拒 -1,对外 schema minimum 0', () => {
    expect(
      debugEvaluateInputSchema.safeParse({ session_id: 'debug-1', expression: 'x', frame_id: -1 }).success,
    ).toBe(false);
    expect(
      debugEvaluateInputSchema.safeParse({ session_id: 'debug-1', expression: 'x', frame_id: 0 }).success,
    ).toBe(true);
    expect(propsOf(debugEvaluateInputJsonSchema).frame_id).toMatchObject({ type: 'integer', minimum: 0 });
  });

  it('advertised schema 不带 $schema 与安全整数默认上下界,保留字段说明', () => {
    for (const inputJsonSchema of ADVERTISED_INPUT_SCHEMAS) {
      expect(inputJsonSchema).not.toHaveProperty('$schema');
      expect(JSON.stringify(inputJsonSchema)).not.toContain(String(Number.MAX_SAFE_INTEGER));
    }
    expect(propsOf(debugThreadControlInputJsonSchema).thread_id?.description).toMatch(/thread id as 0/);
    expect(propsOf(debugStackInputJsonSchema).thread_id?.description).toMatch(/Omit to let the engine/);
    expect(propsOf(debugScopesInputJsonSchema).frame_id?.description).toMatch(/debug\.stack/);
    expect(propsOf(debugSetBreakpointInputJsonSchema).condition?.description).toMatch(/rejected in the MVP/);
    expect(propsOf(debugDisconnectInputJsonSchema).terminate_debuggee?.description).toMatch(/only true/);
  });

  it('variables 输入有分页与输出边界默认值,并限制 count≤100', () => {
    const parsed = debugVariablesInputSchema.parse({
      session_id: 'debug-1',
      variables_reference: 12,
    });

    expect(parsed.start).toBe(0);
    expect(parsed.count).toBe(100);
    expect(parsed.max_depth).toBe(1);
    expect(parsed.max_string_bytes).toBe(65536);
    expect(
      debugVariablesInputSchema.safeParse({
        session_id: 'debug-1',
        variables_reference: 12,
        count: 101,
      }).success,
    ).toBe(false);
  });

  it('evaluate 默认 watch context,限制表达式长度与结果字节预算', () => {
    const parsed = debugEvaluateInputSchema.parse({
      session_id: 'debug-1',
      expression: 'nested.answer',
    });

    expect(parsed.context).toBe('watch');
    expect(parsed.max_result_bytes).toBe(65536);
    expect(
      debugEvaluateInputSchema.safeParse({
        session_id: 'debug-1',
        expression: 'x'.repeat(4097),
      }).success,
    ).toBe(false);
  });

  // 会话都由 Continuo launch,teardown 按进程组整组回收;「只断开、让 debuggee 继续跑」会留下 Continuo
  // 管不到的孤儿。此前 false 被静默忽略(仍终止),现在入口显式拒绝,派生出的 JSON schema 为 const:true。
  it('disconnect 只接受 terminate_debuggee=true(或省略),false 显式拒绝', () => {
    expect(
      debugDisconnectInputSchema.parse({ session_id: 'debug-1' }).terminate_debuggee,
    ).toBe(true);
    expect(
      debugDisconnectInputSchema.safeParse({ session_id: 'debug-1', terminate_debuggee: true }).success,
    ).toBe(true);
    const rejected = debugDisconnectInputSchema.safeParse({
      session_id: 'debug-1',
      terminate_debuggee: false,
    });
    expect(rejected.success).toBe(false);
    expect(rejected.error?.issues[0]?.message).toMatch(/always terminates/i);

    const properties = (debugDisconnectInputJsonSchema as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(properties.terminate_debuggee).toMatchObject({ type: 'boolean', const: true });
  });

  it('launch 的 env 在 advertised schema 中说明拒绝会加载额外代码的变量', () => {
    const env = (debugLaunchInputJsonSchema as { properties: Record<string, Record<string, unknown>> })
      .properties.env!;
    expect(env.description).toMatch(/NODE_OPTIONS/);
    expect(env.description).toMatch(/LD_\*/);
    expect(env.description).toMatch(/DYLD_\*/);
    expect(env.description).toMatch(/OPENSSL_\*/);
    expect(env.description).toMatch(/GCONV_PATH/);
  });

  it('strict 拒未知字段,breakpoint 预留条件字段当前显式拒绝', () => {
    expect(
      debugSetBreakpointInputSchema.safeParse({
        session_id: 'debug-1',
        file: '/tmp/app.ts',
        line: 10,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      debugSetBreakpointInputSchema.safeParse({
        session_id: 'debug-1',
        file: '/tmp/app.ts',
        line: 10,
        condition: 'i === 3',
      }).success,
    ).toBe(false);
  });
});
