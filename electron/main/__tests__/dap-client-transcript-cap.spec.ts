import { describe, expect, it } from 'vitest';
import {
  DapClient,
  DAP_TRANSCRIPT_ENTRY_MAX_BYTES,
  DAP_TRANSCRIPT_MAX_BYTES,
  DAP_TRANSCRIPT_MAX_ENTRIES,
  type DapEventMessage,
  type DapResponseMessage,
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

  // 只按条数封顶时,单帧最大 64MiB:反复 evaluate 大字符串会让 transcript 留住 GB 级数据。
  it('大响应只存截断摘要,总字节不超过预算(父子共享同一预算)', () => {
    const parent = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    const child = parent.createChildSession();
    const big = 'x'.repeat(1024 * 1024);
    for (let i = 1; i <= 40; i += 1) {
      const response = {
        seq: i,
        type: 'response',
        request_seq: i,
        success: true,
        command: 'evaluate',
        body: { result: big },
      } as DapResponseMessage;
      (i % 2 === 0 ? child : parent).receiveMessage(response);
    }

    const sizes = parent.transcript.map((entry) => Buffer.byteLength(JSON.stringify(entry), 'utf8'));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(DAP_TRANSCRIPT_ENTRY_MAX_BYTES + 1024);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(
      DAP_TRANSCRIPT_MAX_BYTES + 1024 * parent.transcript.length,
    );
    const last = parent.transcript.at(-1)!;
    // 摘要保留定位字段,标明原始大小。
    expect(last.message).toMatchObject({
      seq: 40,
      type: 'response',
      command: 'evaluate',
      request_seq: 40,
      transcriptTruncated: true,
    });
    expect(last.message?.originalBytes).toBeGreaterThan(big.length);
    expect(last.message?.body).toBeUndefined();
  });

  it('服务端 stdout 大块同样截断;小消息原样保留', () => {
    const client = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    (client as unknown as { recordTranscript(entry: unknown): void }).recordTranscript({
      direction: 'server-stdout',
      text: 'y'.repeat(DAP_TRANSCRIPT_ENTRY_MAX_BYTES * 4),
    });
    client.receiveMessage(event(1));
    expect(client.transcript[0]!.text!.length).toBeLessThanOrEqual(DAP_TRANSCRIPT_ENTRY_MAX_BYTES);
    expect(client.transcript[1]!.message).toEqual(event(1));
  });

  // worker 反复创建 / 结束:DebugService 逐个 dispose 结束的 child,父 client 不能继续持有它们。
  it('单独 dispose 的 child 从父 client 的子会话列表中移除', async () => {
    const parent = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    const children = Array.from({ length: 5 }, () => parent.createChildSession());
    await Promise.all(children.slice(0, 4).map((child) => child.dispose()));
    const held = (parent as unknown as { childSessions: DapClient[] }).childSessions;
    expect(held).toEqual([children[4]]);
    await parent.dispose();
    expect((parent as unknown as { childSessions: DapClient[] }).childSessions).toEqual([]);
  });

  it('总字节预算按最旧优先淘汰', () => {
    const client = new DapClient({ adapterPath: '/nonexistent/adapter.js' });
    const filler = 'z'.repeat(DAP_TRANSCRIPT_ENTRY_MAX_BYTES - 512);
    const total = Math.ceil((DAP_TRANSCRIPT_MAX_BYTES * 3) / filler.length);
    for (let i = 1; i <= total; i += 1) {
      client.receiveMessage({
        seq: i,
        type: 'event',
        event: 'output',
        body: { output: filler },
      } as DapEventMessage);
    }
    expect(client.transcript.length).toBeLessThan(total);
    expect(client.transcript.at(-1)!.message?.seq).toBe(total);
    const bytes = client.transcript.reduce(
      (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.message), 'utf8'),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(DAP_TRANSCRIPT_MAX_BYTES);
  });
});
