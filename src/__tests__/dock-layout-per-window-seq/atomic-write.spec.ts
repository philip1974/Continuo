import { describe, it } from 'vitest';

describe('atomic explorer persistence writes', () => {
  it.todo('T17: writes explorer.json through a temporary file before rename');

  it('T17: never leaves a partially written explorer.json visible to readers', () => {
    throw new Error('not implemented (BDD red)');
  });
});
