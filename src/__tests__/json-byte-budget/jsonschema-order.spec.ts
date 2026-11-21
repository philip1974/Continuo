// 边界(E307,E305/E306 reorder 同族):RegisterPayloadSchema.jsonSchema superRefine 先字节下界 fail-fast
// 再 assertJsonValue(boundedValueDeepAdmissible 形态闸之后)—— 超 64KiB 但 shape 合法的 schema 不应先被
// assertJsonValue 完整遍历。独立 spec:mock assert-json-value spy assertJsonValue 是否被调用。
import { describe, it, expect, vi } from 'vitest';

const { assertJsonValueSpy } = vi.hoisted(() => ({ assertJsonValueSpy: vi.fn() }));
vi.mock('../../../electron/shared/assert-json-value', () => ({
  assertJsonValue: assertJsonValueSpy,
}));

import { RegisterPayloadSchema } from '../../../electron/shared/plugin-mcp-schemas';

const base = { pluginId: 'p.alpha', name: 'tool', description: '' };

describe('RegisterPayloadSchema jsonSchema 校验顺序 (E307)', () => {
  it('超 64KiB 但 shape 合法的 jsonSchema → reject,且字节 fail-fast 在 assertJsonValue 之前(不被调用)', () => {
    const r = RegisterPayloadSchema.safeParse({
      ...base,
      jsonSchema: { big: 'x'.repeat(70 * 1024) }, // 1 key + 70KB 字符串:过形态闸,字节 > 64KiB
    });
    expect(r.success).toBe(false);
    // neutralize 敏感:旧序(assertJsonValue 在前)则 assertJsonValue 被调用。
    expect(assertJsonValueSpy).not.toHaveBeenCalled();
  });

  it('上限内 jsonSchema → 进入 assertJsonValue(被调用)', () => {
    assertJsonValueSpy.mockClear();
    const r = RegisterPayloadSchema.safeParse({
      ...base,
      jsonSchema: { type: 'object', additionalProperties: false },
    });
    expect(r.success).toBe(true);
    expect(assertJsonValueSpy).toHaveBeenCalled();
  });
});
