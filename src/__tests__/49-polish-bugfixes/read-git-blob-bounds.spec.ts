// topic 49 · 审计 P2-B: readGitBlob 带超时 + 字节上限。
// 用真实 git repo + git hash-object 写 blob,验证正常读取 + 超限 reject。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readGitBlob } from '../../../electron/main/services/plugin-fs.service';

let repo: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo }).toString();
}

async function hashBlob(content: string): Promise<string> {
  const file = path.join(repo, 'blob-src.txt');
  await writeFile(file, content, 'utf-8');
  return git(['hash-object', '-w', file]).trim();
}

describe('topic 49 · readGitBlob 边界', () => {
  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'topic49-gitblob-'));
    git(['init', '-q']);
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it('正常读取 blob 内容', async () => {
    const sha = await hashBlob('hello blob');
    const out = await readGitBlob(repo, sha);
    expect(Buffer.from(out).toString('utf-8')).toBe('hello blob');
  });

  it('blob 超过 maxBytes → reject(不无界累积)', async () => {
    const sha = await hashBlob('0123456789'); // 10 bytes
    await expect(
      readGitBlob(repo, sha, { maxBytes: 4 }),
    ).rejects.toThrow(/exceeds/);
  });

  it('不存在的 sha → reject(git 非 0 退出)', async () => {
    await expect(
      readGitBlob(repo, '0'.repeat(40)),
    ).rejects.toThrow(/git cat-file failed/);
  });
});
