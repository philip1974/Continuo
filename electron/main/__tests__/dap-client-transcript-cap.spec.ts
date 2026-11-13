import { describe, expect, it } from 'vitest';
import {
  DapClient,
  DAP_TRANSCRIPT_MAX_ENTRIES,
  type DapEventMessage,
} from '../services/dap-client';

// DapClient 把每条收发的 DAP 消息都追加进内存 transcript(诊断用,生产无人读)。此前无上限:长调试会话
// 里 variables / stackTrace 等大 payload 随消息数单调累积,直到 session 结束才释放。改为只保留最近 N 条。
describe('DapClient transcript 有界', () => {
  const event = (seq: number): DapEventMessage =>
    ({ seq, type: 'event', event: 'output', body: { output: `line ${seq}` } }) as DapEventMessage;

  it('超过上限后只保留最近的条目,长度不超过上限', () => {
    const client = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    const total = DAP_TRANSCRIPT_MAX_ENTRIES * 3 + 7;
    for (let i = 1; i <= total; i += 1) client.receiveMessage(event(i));

    expect(client.transcript.length).toBeLessThanOrEqual(DAP_TRANSCRIPT_MAX_ENTRIES);
    expect(client.transcript.length).toBeGreaterThan(DAP_TRANSCRIPT_MAX_ENTRIES / 2 - 1);
    const last = client.transcript[client.transcript.length - 1] as { message: DapEventMessage };
    expect(last.message.seq).toBe(total);
    const first = client.transcript[0] as { message: DapEventMessage };
    expect(first.message.seq).toBeGreaterThan(total - DAP_TRANSCRIPT_MAX_ENTRIES);
  });

  it('子 session 共享父 session 的同一份有界 transcript', () => {
    const parent = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    const child = parent.createChildSession();
    expect(child.transcript).toBe(parent.transcript);
    for (let i = 1; i <= DAP_TRANSCRIPT_MAX_ENTRIES + 10; i += 1) child.receiveMessage(event(i));
    expect(parent.transcript.length).toBeLessThanOrEqual(DAP_TRANSCRIPT_MAX_ENTRIES);
  });
});
