import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  allocateWindowSeq,
  defaultExplorerV3,
  loadExplorer,
} from '../../../electron/main/persistence';
import { atomicWriteJson } from '../../../electron/main/lib/atomic-write';
import { _resetExplorerFileMutex } from '../../../electron/main/lib/file-mutex';

describe('allocateWindowSeq atomic concurrent allocation', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    _resetExplorerFileMutex();
    dir = await mkdtemp(path.join(tmpdir(), 'lm-alloc-'));
    file = path.join(dir, 'explorer.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('T28a: single call returns current nextWindowSeq and increments it', async () => {
    await atomicWriteJson(file, defaultExplorerV3());

    const seq = await allocateWindowSeq(file);

    expect(seq).toBe(1);
    const loaded = await loadExplorer(file);
    expect(loaded?.nextWindowSeq).toBe(2);
  });

  it('T28b: missing file creates default v3 and returns 1', async () => {
    const seq = await allocateWindowSeq(file);

    expect(seq).toBe(1);
    const loaded = await loadExplorer(file);
    expect(loaded?.nextWindowSeq).toBe(2);
  });

  it('T28c: 100 concurrent calls return 100 unique seqs', async () => {
    await atomicWriteJson(file, defaultExplorerV3());

    const seqs = await Promise.all(
      Array.from({ length: 100 }, () => allocateWindowSeq(file)),
    );

    expect(new Set(seqs).size).toBe(100);
    const loaded = await loadExplorer(file);
    expect(loaded?.nextWindowSeq).toBe(101);
  });
});
