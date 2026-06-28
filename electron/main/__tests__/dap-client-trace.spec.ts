import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DapClient, type DapEventMessage } from '../services/dap-client';

// dev-gated DAP transcript logger(#2 诊断):CONTINUO_DEBUG_DAP_TRACE 设为文件路径时,
// 每条 DAP 收发落 JSONL;未设零写。child session 标识从 parent 派生,可区分 parent/child
// 的 stopped 事件——这正是定位"命中断点 reason 仍报 entry"所需的 ground truth。
describe('DapClient · dev-gated DAP transcript logger (#2 诊断)', () => {
  let dir: string;

  const stopped = (reason: string, seq: number): DapEventMessage => ({
    type: 'event',
    event: 'stopped',
    body: { reason, threadId: 0 },
    seq,
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dap-trace-'));
  });

  afterEach(async () => {
    delete process.env.CONTINUO_DEBUG_DAP_TRACE;
    await rm(dir, { recursive: true, force: true });
  });

  it('未设 CONTINUO_DEBUG_DAP_TRACE → 不写文件(零开销)', () => {
    const file = path.join(dir, 'trace.jsonl');
    delete process.env.CONTINUO_DEBUG_DAP_TRACE;
    const client = new DapClient({});
    client.receiveMessage(stopped('breakpoint', 1));
    expect(existsSync(file)).toBe(false);
  });

  it('设置后 → stopped 事件落 JSONL,含 reason/threadId + dir + client 标识', () => {
    const file = path.join(dir, 'trace.jsonl');
    process.env.CONTINUO_DEBUG_DAP_TRACE = file;
    const client = new DapClient({});
    client.receiveMessage(stopped('breakpoint', 7));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    const parsed = JSON.parse(lines.at(-1)!);
    expect(parsed).toMatchObject({
      dir: 'recv',
      type: 'event',
      event: 'stopped',
      body: { reason: 'breakpoint', threadId: 0 },
    });
    expect(typeof parsed.client).toBe('string');
  });

  it('child session 的 trace 标识从 parent 派生 → 可区分 parent/child 的 stopped', () => {
    const file = path.join(dir, 'trace.jsonl');
    process.env.CONTINUO_DEBUG_DAP_TRACE = file;
    const parent = new DapClient({});
    const child = parent.createChildSession();
    parent.receiveMessage(stopped('entry', 1));
    child.receiveMessage(stopped('breakpoint', 2));
    const lines = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { client: string; body?: { reason?: string } });
    const parentLine = lines.find((l) => l.body?.reason === 'entry');
    const childLine = lines.find((l) => l.body?.reason === 'breakpoint');
    expect(parentLine?.client).toBeDefined();
    expect(childLine?.client).toBeDefined();
    expect(parentLine?.client).not.toBe(childLine?.client);
    expect(childLine?.client).toContain('child');
  });
});
