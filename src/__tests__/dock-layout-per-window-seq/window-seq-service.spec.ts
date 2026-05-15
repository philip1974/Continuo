import { beforeEach, describe, expect, it } from 'vitest';

import {
  _reset,
  clearWindow,
  getActiveSeqs,
  getWindowSeq,
  setWindowSeq,
} from '../../../electron/main/services/window-seq.service';

beforeEach(() => {
  _reset();
});

describe('window sequence service API', () => {
  it('T8a: setWindowSeq + getWindowSeq returns the seq', () => {
    setWindowSeq(1, 5);

    expect(getWindowSeq(1)).toBe(5);
  });

  it('T8b: getWindowSeq for unknown id returns null (not undefined)', () => {
    expect(getWindowSeq(999)).toBeNull();
  });

  it('T8c: clearWindow removes mapping', () => {
    setWindowSeq(1, 5);
    clearWindow(1);

    expect(getWindowSeq(1)).toBeNull();
  });

  it('T8d: getActiveSeqs returns all current seqs as Set', () => {
    setWindowSeq(1, 10);
    setWindowSeq(2, 11);
    setWindowSeq(3, 12);

    expect(getActiveSeqs()).toEqual(new Set([10, 11, 12]));
  });

  it('T8e: getActiveSeqs after clearWindow excludes cleared', () => {
    setWindowSeq(1, 10);
    setWindowSeq(2, 11);
    clearWindow(1);

    expect(getActiveSeqs()).toEqual(new Set([11]));
  });

  it('T8f: setWindowSeq overwrites existing', () => {
    setWindowSeq(1, 5);
    setWindowSeq(1, 7);

    expect(getWindowSeq(1)).toBe(7);
  });

  it('T8g: _reset clears all', () => {
    setWindowSeq(1, 5);
    setWindowSeq(2, 6);
    _reset();

    expect(getWindowSeq(1)).toBeNull();
    expect(getActiveSeqs().size).toBe(0);
  });
});
