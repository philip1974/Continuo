import { describe, it } from 'vitest';

describe('window close layout flush', () => {
  it.todo('T14: wireWindowCloseFlush persists the closing window layout before teardown');
  it.todo('T20: close flush updates main-owned lastClosedAt for the closing window');

  it('T14/T20: flushes only the closing window entry and preserves other windows', () => {
    throw new Error('not implemented (BDD red)');
  });
});
