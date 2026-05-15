import { describe, it } from 'vitest';

describe('migrateExplorerFileToV3 edge paths', () => {
  it.todo('T11: migrates an empty or missing explorer file into v3 defaults');
  it.todo('T11: migrates a v2-only explorer file into the current window entry');
  it.todo('T11: migrates a layout-only file into the current window layout section');
  it.todo('T11: migrates mixed explorer and layout payloads without dropping either side');

  it('T11: handles all four migration paths idempotently', () => {
    throw new Error('not implemented (BDD red)');
  });
});
