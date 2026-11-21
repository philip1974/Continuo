// 边界(E146,plugin-fs scope-decision requestId ≤256 同型对齐):agentAuth.respond 的 requestId
// 须有长度上限 —— 防畸形/恶意 renderer 用超长 requestId 反复触发 IPC 解析 + pending.get 放大 main
// 内存/CPU,且与其它 requestId 回执通道契约一致。
import { describe, it, expect } from 'vitest';
import { AgentAuthRespondSchema } from '../../../electron/main/agent-auth-schema';

describe('AgentAuthRespondSchema (E146)', () => {
  it('合法 requestId + decision → ok', () => {
    expect(
      AgentAuthRespondSchema.safeParse({ requestId: 'r-1', decision: 'once' })
        .success,
    ).toBe(true);
    expect(
      AgentAuthRespondSchema.safeParse({
        requestId: 'x'.repeat(256),
        decision: 'session',
      }).success,
    ).toBe(true);
  });

  it('E146 requestId 超 256 → fail', () => {
    expect(
      AgentAuthRespondSchema.safeParse({
        requestId: 'x'.repeat(257),
        decision: 'denied',
      }).success,
    ).toBe(false);
  });

  it('空 requestId / 非法 decision / 未知字段 → fail', () => {
    expect(
      AgentAuthRespondSchema.safeParse({ requestId: '', decision: 'once' })
        .success,
    ).toBe(false);
    expect(
      AgentAuthRespondSchema.safeParse({ requestId: 'r', decision: 'evil' })
        .success,
    ).toBe(false);
    expect(
      AgentAuthRespondSchema.safeParse({
        requestId: 'r',
        decision: 'once',
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
