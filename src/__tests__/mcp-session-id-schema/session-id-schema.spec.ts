// BDD: mcp-session-id-schema
// terminal / hook-bridge 的对外 session_id JSON schema 与共享 zod 常量逐字段一致;运行时共用同一边界。
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { sessionIdSchema } from '../../../electron/shared/session-id-schema';
import { SESSION_ID_MAX } from '../../../electron/shared/session-id-limits';
import {
  makeKillTool,
  makePressKeyTool,
  makeReadOutputTool,
  makeSendInputTool,
  makeSendTextTool,
} from '../../../electron/main/services/mcp-tools-terminal';
import { createAwaitStopHookTool } from '../../../electron/main/services/mcp-tools-hook-bridge';

interface ToolShape {
  readonly name: string;
  readonly jsonSchema: Record<string, unknown>;
  readonly inputSchema: z.ZodType;
}

// 只读 jsonSchema / inputSchema,工厂构造期不触达 deps。
const TOOLS: readonly ToolShape[] = [
  makeSendInputTool({} as never),
  makeSendTextTool({} as never),
  makePressKeyTool({} as never),
  makeReadOutputTool({} as never),
  makeKillTool({} as never),
  createAwaitStopHookTool({} as never),
] as unknown as readonly ToolShape[];

const PARITY_KEYS = ['type', 'minLength', 'maxLength'] as const;

function pick(schema: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(PARITY_KEYS.map((k) => [k, schema[k]]));
}

describe('mcp-session-id-schema', () => {
  const sharedJson = z.toJSONSchema(sessionIdSchema, { io: 'input' }) as Record<string, unknown>;

  it('共享 sessionIdSchema:min 1、max SESSION_ID_MAX', () => {
    expect(pick(sharedJson)).toEqual({ type: 'string', minLength: 1, maxLength: SESSION_ID_MAX });
  });

  for (const tool of TOOLS) {
    it(`${tool.name}:对外 session_id 与共享 zod 逐字段一致且必填`, () => {
      const props = tool.jsonSchema.properties as Record<string, Record<string, unknown>>;
      expect(pick(props.session_id!)).toEqual(pick(sharedJson));
      expect(tool.jsonSchema.required).toContain('session_id');
    });

    it(`${tool.name}:运行时拒空串与超长 session_id`, () => {
      const sessionIdField = (tool.inputSchema as unknown as { shape: Record<string, z.ZodType> }).shape
        .session_id!;
      expect(sessionIdField.safeParse('').success).toBe(false);
      expect(sessionIdField.safeParse('x'.repeat(SESSION_ID_MAX + 1)).success).toBe(false);
      expect(sessionIdField.safeParse('term-1').success).toBe(true);
    });
  }
});
