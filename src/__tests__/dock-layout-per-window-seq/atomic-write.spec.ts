import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { atomicWriteJson } from '../../../electron/main/lib/atomic-write';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), 'continuo-atomic-json-'));
  file = path.join(dir, 'explorer.json');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('atomic explorer persistence writes', () => {
  it('T17: writes temp file in the same directory with a unique suffix', async () => {
    const renameSpy = vi.spyOn(fs, 'rename');

    await atomicWriteJson(file, { a: 1 });
    await atomicWriteJson(file, { b: 2 });

    const tempPaths = renameSpy.mock.calls.map(([tempPath]) =>
      String(tempPath),
    );
    expect(tempPaths).toHaveLength(2);
    expect(new Set(tempPaths).size).toBe(2);
    for (const tempPath of tempPaths) {
      expect(path.dirname(tempPath)).toBe(dir);
      expect(path.basename(tempPath)).toMatch(
        /^\.explorer\.json\.\d+\.[a-f0-9]{8}\.tmp$/,
      );
    }
  });

  it('T17: writes the final JSON file and leaves no temp file after rename', async () => {
    const payload = { version: 3, windows: { '1': { layout: { panels: [] } } } };

    await atomicWriteJson(file, payload);

    expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual(payload);
    const entries = await fs.readdir(dir);
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('T17: does not create the target file when JSON.stringify fails', async () => {
    const payload: { self?: unknown } = {};
    payload.self = payload;

    await expect(atomicWriteJson(file, payload)).rejects.toThrow(
      /circular structure/i,
    );
    expect(existsSync(file)).toBe(false);
  });

  it('T17: unlinks the temp file when rename fails', async () => {
    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('rename failed'));

    await expect(atomicWriteJson(file, { version: 3 })).rejects.toThrow(
      'rename failed',
    );

    const tempPath = String(renameSpy.mock.calls[0]?.[0]);
    expect(path.dirname(tempPath)).toBe(dir);
    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(file)).toBe(false);
    const entries = await fs.readdir(dir);
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });
});
