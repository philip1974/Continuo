// BDD: agent-terminal-mcp-install-stop-hook · I11 readFileCappedFd({ noFollow }) 读取侧契约
//
// 不跟随末级符号链接(ELOOP)、只读普通文件(EFTYPE)、返回读到的 inode 身份。两条实现路径都要成立:
// POSIX 的 O_NOFOLLOW,以及 fs.constants.O_NOFOLLOW 不可用(Windows)时的 lstat → open → fstat 同 inode 退化。

import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ hideNoFollow: false }));
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  const real = orig.constants.O_NOFOLLOW;
  const constants = Object.defineProperty({ ...orig.constants }, 'O_NOFOLLOW', {
    get: () => (flags.hideNoFollow ? undefined : real),
  });
  return { ...orig, constants, default: { ...orig, constants } };
});

const { readFileCappedFd } = await import('../../../electron/main/lib/read-fh-capped');

const roots: string[] = [];
afterEach(async () => {
  flags.hideNoFollow = false;
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

for (const hide of [false, true]) {
  describe.skipIf(process.platform === 'win32')(
    `readFileCappedFd noFollow(${hide ? 'lstat+fstat 退化路径' : 'O_NOFOLLOW'})`,
    () => {
      it('普通文件:读出内容并返回 inode 身份', async () => {
        flags.hideNoFollow = hide;
        const d = await mkdtemp(join(tmpdir(), 'continuo-nofollow-'));
        roots.push(d);
        const f = join(d, 'a.toml');
        await writeFile(f, 'x = 1\n', 'utf8');
        const st = await stat(f);
        await expect(readFileCappedFd(f, 1024, { noFollow: true })).resolves.toMatchObject({
          text: 'x = 1\n',
          identity: { dev: st.dev, ino: st.ino },
        });
      });

      it('末级是符号链接 → ELOOP;目录 → EFTYPE', async () => {
        flags.hideNoFollow = hide;
        const d = await mkdtemp(join(tmpdir(), 'continuo-nofollow-'));
        roots.push(d);
        await writeFile(join(d, 'secret'), 'S', 'utf8');
        await symlink(join(d, 'secret'), join(d, 'link'));
        await mkdir(join(d, 'dir'));
        await expect(readFileCappedFd(join(d, 'link'), 1024, { noFollow: true })).rejects.toMatchObject({
          code: 'ELOOP',
        });
        await expect(readFileCappedFd(join(d, 'dir'), 1024, { noFollow: true })).rejects.toMatchObject({
          code: expect.stringMatching(/^(EFTYPE|EISDIR)$/),
        });
      });
    },
  );
}
