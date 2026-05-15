import { describe, it } from 'vitest';

describe('atomic windowSeq allocation', () => {
  it.todo('T28: allocateWindowSeq assigns unique increasing IDs under concurrent creation');

  it('T28: serializes concurrent allocateWindowSeq calls through persistence locking', () => {
    throw new Error('not implemented (BDD red)');
  });
});
