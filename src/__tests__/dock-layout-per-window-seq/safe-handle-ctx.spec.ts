import { describe, expect, it } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';

import {
  processIpcCall,
  processIpcCallWithCtx,
} from '../../../electron/main/safe-handle';
import { IPC_ERR } from '../../../electron/shared/ipc-result';

const trustAll = () => true;
const trustNone = () => false;

const event = {
  senderFrame: { url: 'file:///x' },
  sender: {},
} as IpcMainInvokeEvent;

describe('safeHandleWithCtx coded error contract', () => {
  it('T19: ctx-aware handler receives event while existing processIpcCall stays ctx-free', async () => {
    let receivedEvent: IpcMainInvokeEvent | undefined;
    let oldHandlerArgCount = -1;

    const ctxResult = await processIpcCallWithCtx(
      z.object({ value: z.string() }),
      (input, ctx) => {
        receivedEvent = ctx.event;
        return input.value.toUpperCase();
      },
      { value: 'ok' },
      event,
      trustAll,
    );

    const oldResult = await processIpcCall(
      z.string(),
      function (input: string) {
        oldHandlerArgCount = arguments.length;
        return input;
      },
      'legacy',
      event.senderFrame,
      trustAll,
    );

    expect(ctxResult).toEqual({ ok: true, data: 'OK' });
    expect(receivedEvent).toBe(event);
    expect(oldResult).toEqual({ ok: true, data: 'legacy' });
    expect(oldHandlerArgCount).toBe(1);
  });

  it('T27: handler throw Error with .code returns coded IPC failure', async () => {
    const result = await processIpcCallWithCtx(
      z.unknown(),
      () => {
        throw Object.assign(new Error('no win'), { code: 'NO_WINDOW' });
      },
      undefined,
      event,
      trustAll,
    );

    expect(result).toEqual({
      ok: false,
      code: 'NO_WINDOW',
      message: 'no win',
    });
  });

  it('T27: handler throw Error without .code uses IPC_HANDLER_ERROR', async () => {
    const result = await processIpcCallWithCtx(
      z.unknown(),
      () => {
        throw new Error('boom');
      },
      undefined,
      event,
      trustAll,
    );

    expect(result).toEqual({
      ok: false,
      code: IPC_ERR.HANDLER_ERROR,
      message: 'boom',
    });
  });

  it('T27: handler throw non-Error string returns String(err) message', async () => {
    const result = await processIpcCallWithCtx(
      z.unknown(),
      () => {
        throw 'oops';
      },
      undefined,
      event,
      trustAll,
    );

    expect(result).toEqual({
      ok: false,
      code: IPC_ERR.HANDLER_ERROR,
      message: 'oops',
    });
  });

  it('T19/T27: schema parse failure returns IPC_BAD_INPUT', async () => {
    const result = await processIpcCallWithCtx(
      z.object({ windowSeq: z.number() }),
      () => 'ok',
      { windowSeq: 'wrong' },
      event,
      trustAll,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(IPC_ERR.BAD_INPUT);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('T19/T27: untrusted frame returns IPC_DENIED before parsing or handler execution', async () => {
    let called = false;

    const result = await processIpcCallWithCtx(
      z.unknown(),
      () => {
        called = true;
        return 'ok';
      },
      undefined,
      event,
      trustNone,
    );

    expect(result).toEqual({
      ok: false,
      code: IPC_ERR.DENIED,
      message: 'sender frame is not trusted',
    });
    expect(called).toBe(false);
  });
});
