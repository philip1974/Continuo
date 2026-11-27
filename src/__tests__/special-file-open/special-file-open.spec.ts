// BDD: special-file-open / FIFO 与 socket 打开都报「不是文件」(FS_NOT_FILE)
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile } from '../../../electron/main/ipc/fs/read-file';

const posix = process.platform !== 'win32';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'special-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('编辑器打开特殊文件', () => {
  it.skipIf(!posix)('FIFO → FS_NOT_FILE', async () => {
    const fifo = path.join(dir, 'p');
    execFileSync('mkfifo', [fifo]);
    await expect(readFile(fifo)).rejects.toMatchObject({ code: 'FS_NOT_FILE' });
  });

  it.skipIf(!posix)('Unix socket → FS_NOT_FILE(与 FIFO 一致,不是「文件 I/O 错误」)', async () => {
    const sock = path.join(dir, 's');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      await expect(readFile(sock)).rejects.toMatchObject({ code: 'FS_NOT_FILE' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
