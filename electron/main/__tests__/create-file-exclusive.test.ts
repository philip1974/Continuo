import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFile } from '../ipc/fs/create';
import { ERROR_CODES } from '../../shared/error-codes';

// 数据安全(codex 复查 P1):createFile 必须原子排他创建,已存在则 FS_EEXIST 且
// **不覆盖既有内容**(此前 stat+atomicWriteFile 的 rename 会用空文件覆盖 → 丢内容)。
describe('createFile — 原子排他、不覆盖既有文件', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'continuo-createfile-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('创建空文件并返回路径', async () => {
    const p = await createFile(dir, 'a.txt');
    expect(p).toBe(path.join(dir, 'a.txt'));
    expect(await readFile(p, 'utf-8')).toBe('');
  });

  it('已存在 → FS_EEXIST,且既有内容不被覆盖(数据安全)', async () => {
    const p = path.join(dir, 'b.txt');
    await writeFile(p, 'user content');
    await expect(createFile(dir, 'b.txt')).rejects.toMatchObject({
      code: ERROR_CODES.FS_EEXIST,
    });
    // 关键断言:内容仍在,没被空文件覆盖
    expect(await readFile(p, 'utf-8')).toBe('user content');
  });
});
