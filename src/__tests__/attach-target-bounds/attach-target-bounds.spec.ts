// 边界(E23,E11/E21 同族):AttachTargetSchema 的 panelId/windowId 加长度/安全整数/非负边界。
// MCP create_session 用它校验入参 target(接受、校验,但目前不消费)。
import { describe, it, expect } from 'vitest';
import { AttachTargetSchema } from '../../../electron/shared/terminal-attach';

describe('AttachTargetSchema bounds (E23)', () => {
  it('合法 active/panel/window → ok', () => {
    expect(AttachTargetSchema.safeParse({ kind: 'active' }).success).toBe(true);
    expect(
      AttachTargetSchema.safeParse({ kind: 'panel', panelId: 'terminal-abc' })
        .success,
    ).toBe(true);
    expect(
      AttachTargetSchema.safeParse({ kind: 'window', windowId: 3 }).success,
    ).toBe(true);
    expect(
      AttachTargetSchema.safeParse({ kind: 'window', windowId: 0 }).success,
    ).toBe(true);
  });

  it('panelId 超 256 → fail', () => {
    expect(
      AttachTargetSchema.safeParse({
        kind: 'panel',
        panelId: 'x'.repeat(257),
      }).success,
    ).toBe(false);
  });

  it('panelId 空串 → fail(既有 min1)', () => {
    expect(
      AttachTargetSchema.safeParse({ kind: 'panel', panelId: '' }).success,
    ).toBe(false);
  });

  it('windowId 负数 → fail', () => {
    expect(
      AttachTargetSchema.safeParse({ kind: 'window', windowId: -1 }).success,
    ).toBe(false);
  });

  it('windowId 不安全整数(≥2^53)→ fail', () => {
    expect(
      AttachTargetSchema.safeParse({
        kind: 'window',
        windowId: 9007199254740992, // 2^53 = MAX_SAFE_INTEGER + 1
      }).success,
    ).toBe(false);
  });

  it('windowId 非整数 → fail', () => {
    expect(
      AttachTargetSchema.safeParse({ kind: 'window', windowId: 1.5 }).success,
    ).toBe(false);
  });
});
