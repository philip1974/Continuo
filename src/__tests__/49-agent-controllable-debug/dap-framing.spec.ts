import { describe, expect, it } from 'vitest';

import {
  encodeMessage,
  StreamDecoder,
} from '../../../scripts/debug-spike/dap-client.mjs';

describe('49 · DAP Content-Length framing', () => {
  it('encodes a JSON message and decodes it back', () => {
    const decoder = new StreamDecoder();
    const message = {
      seq: 1,
      type: 'request',
      command: 'initialize',
      arguments: { adapterID: 'pwa-node' },
    };

    const encoded = encodeMessage(message);
    expect(encoded.toString('utf8')).toMatch(/^Content-Length: \d+\r\n\r\n/);

    expect(decoder.push(encoded)).toEqual([message]);
  });

  it('reassembles a message split across chunk boundaries', () => {
    const decoder = new StreamDecoder();
    const message = {
      seq: 2,
      type: 'event',
      event: 'stopped',
      body: { reason: 'breakpoint', threadId: 1 },
    };
    const encoded = encodeMessage(message);
    const chunks = [
      encoded.subarray(0, 7),
      encoded.subarray(7, 21),
      encoded.subarray(21, 45),
      encoded.subarray(45),
    ];

    expect(decoder.push(chunks[0])).toEqual([]);
    expect(decoder.push(chunks[1])).toEqual([]);
    expect(decoder.push(chunks[2])).toEqual([]);
    expect(decoder.push(chunks[3])).toEqual([message]);
  });

  it('decodes multiple messages delivered in one chunk', () => {
    const decoder = new StreamDecoder();
    const first = { seq: 3, type: 'response', request_seq: 1, success: true };
    const second = {
      seq: 4,
      type: 'event',
      event: 'initialized',
      body: {},
    };

    expect(
      decoder.push(Buffer.concat([encodeMessage(first), encodeMessage(second)])),
    ).toEqual([first, second]);
  });
});
