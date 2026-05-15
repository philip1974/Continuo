import { describe, it } from 'vitest';

describe('window-scoped layout IPC', () => {
  it.todo('T9: layout:read resolves the current BrowserWindow from event.sender');
  it.todo('T10: layout:write persists only the sender window layout');
  it.todo('T13: explorer:write cannot overwrite layout data for another window');
  it.todo('T16: multi-window mocks keep two layouts independent');
  it.todo('T25: IPC failures expose stable coded errors');

  it('T9/T10/T13/T16/T25: routes read and write calls through sender-owned windowSeq', () => {
    throw new Error('not implemented (BDD red)');
  });
});
