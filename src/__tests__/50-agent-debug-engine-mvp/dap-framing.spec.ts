import { describe, expect, it } from 'vitest';

import {
  DapStreamDecoder,
  encodeDapMessage,
} from '../../../electron/main/services/dap-client';

describe('50 · DAP Content-Length framing', () => {
  it('编码后可解回同一 JSON message', () => {
    const decoder = new DapStreamDecoder();
    const message = {
      seq: 1,
      type: 'request',
      command: 'initialize',
      arguments: { adapterID: 'pwa-node' },
    };

    const encoded = encodeDapMessage(message);

    expect(encoded.toString('utf8')).toMatch(/^Content-Length: \d+\r\n\r\n/);
    expect(decoder.push(encoded)).toEqual([message]);
  });

  it('跨 chunk 重组完整 frame', () => {
    const decoder = new DapStreamDecoder();
    const message = {
      seq: 2,
      type: 'event',
      event: 'stopped',
      body: { reason: 'breakpoint', threadId: 1 },
    };
    const encoded = encodeDapMessage(message);

    expect(decoder.push(encoded.subarray(0, 7))).toEqual([]);
    expect(decoder.push(encoded.subarray(7, 21))).toEqual([]);
    expect(decoder.push(encoded.subarray(21, 45))).toEqual([]);
    expect(decoder.push(encoded.subarray(45))).toEqual([message]);
  });

  it('单 chunk 内连续多个 frame 逐个解出', () => {
    const decoder = new DapStreamDecoder();
    const first = { seq: 3, type: 'response', request_seq: 1, success: true };
    const second = {
      seq: 4,
      type: 'event',
      event: 'initialized',
      body: {},
    };

    expect(
      decoder.push(Buffer.concat([encodeDapMessage(first), encodeDapMessage(second)])),
    ).toEqual([first, second]);
  });
});
