// 边界(E150):parseStopPayload 各字段长度上限。MAX_HOOK_FILE_BYTES 钳整文件 1MiB,但单字段(尤其
// last_assistant_message)仍可接近 1MiB,进 buffered/非 raw MCP 响应/日志放大。标识/路径 ≤FIELD_MAX,
// 正文 ≤LAST_MSG_MAX。
import { describe, it, expect } from 'vitest';
import {
  parseStopPayload,
  FIELD_MAX,
  LAST_MSG_MAX,
} from '../../../electron/main/services/mcp-tools-hook-bridge';

describe('parseStopPayload 字段长度上限 (E150)', () => {
  it('session_id / turn_id / cwd / transcript_path 超 FIELD_MAX → 截断', () => {
    const big = 'x'.repeat(FIELD_MAX + 5000);
    const p = parseStopPayload(
      'cc',
      'cc_4_s_1.jsonl',
      JSON.stringify({
        session_id: big,
        turn_id: big,
        cwd: big,
        transcript_path: big,
      }),
    );
    expect(p).not.toBeNull();
    expect(p!.cliSessionId.length).toBe(FIELD_MAX);
    expect(p!.turnId!.length).toBe(FIELD_MAX);
    expect(p!.cwd!.length).toBe(FIELD_MAX);
    expect(p!.transcriptPath!.length).toBe(FIELD_MAX);
  });

  it('last_assistant_message 超 LAST_MSG_MAX → 截断', () => {
    const huge = 'm'.repeat(LAST_MSG_MAX + 100_000);
    const p = parseStopPayload(
      'codex',
      'codex_4_1.jsonl',
      JSON.stringify({ session_id: 's', last_assistant_message: huge }),
    );
    expect(p).not.toBeNull();
    expect(p!.lastAssistantMessage!.length).toBe(LAST_MSG_MAX);
  });

  it('正常短字段 → 原样保留', () => {
    const p = parseStopPayload(
      'cc',
      'cc_4_s_1.jsonl',
      JSON.stringify({
        session_id: 'sess-1',
        turn_id: 't-1',
        cwd: '/work',
        last_assistant_message: 'done',
      }),
    );
    expect(p).not.toBeNull();
    expect(p!.cliSessionId).toBe('sess-1');
    expect(p!.lastAssistantMessage).toBe('done');
  });
});
