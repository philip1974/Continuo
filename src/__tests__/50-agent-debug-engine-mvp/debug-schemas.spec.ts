import { describe, expect, it } from 'vitest';

import {
  DEBUG_TOOL_SCHEMAS,
  debugEvaluateInputSchema,
  debugSetBreakpointInputSchema,
  debugVariablesInputSchema,
} from '../../../electron/shared/mcp-debug-schemas';

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

describe('50 · debug_* schemas', () => {
  it('所有 advertised object schema 都关闭 additionalProperties', () => {
    for (const tool of DEBUG_TOOL_SCHEMAS) {
      const objectSchemas = collectObjectSchemas(tool.inputJsonSchema).concat(
        collectObjectSchemas(tool.outputJsonSchema),
      );
      expect(objectSchemas.length).toBeGreaterThan(0);
      for (const objectSchema of objectSchemas) {
        expect((objectSchema as Record<string, unknown>).additionalProperties).toBe(
          false,
        );
      }
    }
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
