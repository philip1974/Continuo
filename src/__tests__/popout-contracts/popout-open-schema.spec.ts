// BDD(E316):popout:open 入参 schema 边界 —— panelId 有长度上限且拒绝额外字段。
//
// 行为契约:
//  - 合法 { panelId: 非空 ≤256 字符 } 通过。
//  - panelId 为空串 / 超过 256 字符 → 拒绝(防超长串经 IPC 解析放大)。
//  - 夹带额外字段(.strict)→ 拒绝(不放行 passthrough 任意字段)。
//  - panelId 缺失 / 非字符串 → 拒绝。
import { describe, it, expect } from 'vitest';
import { PopoutOpenInput } from '../../../electron/main/popout-open-schema';

describe('popout:open 入参 schema 边界(E316)', () => {
  it('接受合法的非空、长度 ≤256 的 panelId', () => {
    expect(PopoutOpenInput.safeParse({ panelId: 'panel-1' }).success).toBe(true);
    expect(
      PopoutOpenInput.safeParse({ panelId: 'p'.repeat(256) }).success,
    ).toBe(true);
  });

  it('拒绝空串 panelId(min(1))', () => {
    expect(PopoutOpenInput.safeParse({ panelId: '' }).success).toBe(false);
  });

  it('拒绝超过 256 字符的 panelId(防超长串经 IPC 放大)', () => {
    expect(
      PopoutOpenInput.safeParse({ panelId: 'p'.repeat(257) }).success,
    ).toBe(false);
  });

  it('拒绝夹带额外字段(.strict 不放行 passthrough)', () => {
    expect(
      PopoutOpenInput.safeParse({ panelId: 'panel-1', extra: 'x' }).success,
    ).toBe(false);
  });

  it('拒绝缺失或非字符串 panelId', () => {
    expect(PopoutOpenInput.safeParse({}).success).toBe(false);
    expect(PopoutOpenInput.safeParse({ panelId: 123 }).success).toBe(false);
    expect(PopoutOpenInput.safeParse({ panelId: null }).success).toBe(false);
  });
});
