// 边界(E306,E305 reorder 同族 / 校验顺序 fail-fast):serializeWithinLimit 先字节下界 fail-fast 再
// assertJsonValue —— 超 MAX_PLUGIN_DATA_BYTES 的 data 不应先被 assertJsonValue 完整遍历。
// 独立 spec:mock assert-json-value spy assertJsonValue 是否被调用(行为保持,neutralize 取「顺序」)。
import { describe, it, expect, vi } from 'vitest';

const { assertJsonValueSpy } = vi.hoisted(() => ({ assertJsonValueSpy: vi.fn() }));
vi.mock('../../../electron/shared/assert-json-value', () => ({
  assertJsonValue: assertJsonValueSpy,
}));

import { InMemoryDataStore } from '../../plugins/PluginDataStore';

describe('serializeWithinLimit 校验顺序 (E306)', () => {
  it('超 MAX_PLUGIN_DATA_BYTES → 拒,且字节 fail-fast 在 assertJsonValue 之前(assertJsonValue 不被调用)', async () => {
    const ds = new InMemoryDataStore();
    // ~17MiB 多段子上限字符串(每段 < E285 单串上限)→ 字节下界 > MAX_PLUGIN_DATA_BYTES(16MiB)。
    const huge = Array.from({ length: 17 }, () => 'x'.repeat(1024 * 1024));
    await expect(ds.write('k', huge)).rejects.toThrow(/too large/i);
    // neutralize 敏感:旧序(assertJsonValue 在前)则 assertJsonValue 被调用。
    expect(assertJsonValueSpy).not.toHaveBeenCalled();
  });

  it('上限内 data → 进入 assertJsonValue(被调用)', async () => {
    assertJsonValueSpy.mockClear();
    const ds = new InMemoryDataStore();
    await ds.write('k', { ok: true });
    expect(assertJsonValueSpy).toHaveBeenCalledTimes(1);
  });
});
