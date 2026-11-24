import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteText } from '../lib/atomic-write';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'continuo-atomic-opts-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('atomicWriteText 选项', () => {
  it('二进制内容(Uint8Array / Buffer)逐字节写入', async () => {
    const file = join(dir, 'bin.dat');
    const bytes = Buffer.from([0xff, 0x00, 0xfe, 0x0a]);
    await atomicWriteText(file, bytes);
    expect((await readFile(file)).equals(bytes)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('{ mode } 指定最终权限,不受 umask 削减', async () => {
    const file = join(dir, 'tool.mjs');
    const prev = process.umask(0o177);
    try {
      await atomicWriteText(file, '#!/usr/bin/env node\n', { mode: 0o700 });
    } finally {
      process.umask(prev);
    }
    expect((await stat(file)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === 'win32')('缺省仍为 0600', async () => {
    const file = join(dir, 'state.json');
    await atomicWriteText(file, '{}');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
