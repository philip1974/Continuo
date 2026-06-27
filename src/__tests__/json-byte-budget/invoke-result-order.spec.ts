// 边界(E305,E283 校验顺序 fail-fast):isInvokeResultAdmissible 先廉价字节下界 fail-fast 再
// assertJsonValue 全量遍历 —— 超 RESULT_BYTES_MAX 的 result 不应先被 assertJsonValue 完整遍历。
// 独立 spec:mock assert-json-value 以 spy assertJsonValue 是否被调用(行为保持,故 neutralize 取「顺序」)。
import { describe, it, expect, vi } from 'vitest';

const { assertJsonValueSpy } = vi.hoisted(() => ({
  assertJsonValueSpy: vi.fn(),
}));
vi.mock('../../../electron/shared/assert-json-value', () => ({
  assertJsonValue: assertJsonValueSpy,
}));

import { isInvokeResultAdmissible } from '../../../electron/shared/plugin-mcp-schemas';

describe('isInvokeResultAdmissible 校验顺序 (E305)', () => {
  it('超 RESULT_BYTES_MAX 的「很多中等元素」result → 拒,且字节 fail-fast 在 assertJsonValue 之前(assertJsonValue 不被调用)', () => {
    const chunk = 'x'.repeat(1024 * 1024);
    const huge = Array.from({ length: 11 }, () => chunk); // ~11MiB 字节下界 > RESULT_BYTES_MAX(10MiB)
    expect(isInvokeResultAdmissible(huge)).toBe(false);
    // neutralize 敏感:旧序(assertJsonValue 在前)则 assertJsonValue 会被调用一次。
    expect(assertJsonValueSpy).not.toHaveBeenCalled();
  });

  it('上限内 result → 字节下界 ≤ 上限后才调 assertJsonValue(顺序:byte→assertJsonValue)', () => {
    assertJsonValueSpy.mockClear();
    expect(isInvokeResultAdmissible({ ok: true, items: [1, 2, 3] })).toBe(true);
    // 上限内 → 进入 assertJsonValue(被调用一次)。
    expect(assertJsonValueSpy).toHaveBeenCalledTimes(1);
  });
});
