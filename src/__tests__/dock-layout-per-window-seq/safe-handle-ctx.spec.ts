import { describe, it } from 'vitest';

describe('safeHandleWithCtx coded error contract', () => {
  it.todo('T19: safeHandleWithCtx resolves sender context before invoking the handler');
  it.todo('T27: throw-with-code helpers normalize coded failures for IPC callers');

  it('T19/T27: returns stable coded errors when sender window context is unavailable', () => {
    throw new Error('not implemented (BDD red)');
  });
});
