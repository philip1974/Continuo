import { describe, it } from 'vitest';

describe('explorer persistence file mutex', () => {
  it.todo('T18: serializes concurrent read-modify-write operations for explorer.json');

  it('T18: prevents interleaved writers from dropping either window layout update', () => {
    throw new Error('not implemented (BDD red)');
  });
});
