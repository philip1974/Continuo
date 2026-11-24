// 安全(拖放覆盖写穿符号链接):外部文件拖入 Explorer 走 fs:write-binary,同名静默覆盖(既有产品行为)。
// 此前 handler 复用编辑器保存的 atomicWriteFile —— leaf 为符号链接时 realpath 后**写穿到链接目标**。
// 攻击:恶意仓库放 `README.md -> ~/.ssh/authorized_keys`(git 可存链接),用户从 Finder 拖同名文件进该目录
// → 无确认覆盖 workspace 外文件。
//
// 期望:拖放是「新建 / 放入」语义,不继承「编辑器保存写穿链接」语义 —— 目标是链接时替换**链接本身**为
// 普通文件,链接目标不受影响;同名普通文件照旧静默原子覆盖(产品行为不变)。fs:write-binary 只有拖放一个
// 调用方(编辑器保存走 fs:write-file,仍写穿链接)。

import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeBinaryHandler, writeFileHandler } from '../../../electron/main/ipc/fs.ipc';
import { setupTempDirs } from '../_helpers/tmp-dir';

const tmp = setupTempDirs();

async function setup(): Promise<{ ws: string; outside: string }> {
  const root = await tmp.make('continuo-drop-nofollow-');
  const ws = join(root, 'ws');
  const outside = join(root, 'authorized_keys');
  await writeFile(outside, 'ssh-ed25519 VICTIM\n', 'utf8');
  await mkdir(ws);
  return { ws, outside };
}

const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

describe.skipIf(process.platform === 'win32')('fs:write-binary(拖放落盘)不跟随 leaf 符号链接', () => {
  it('目标是指向 workspace 外的链接 → 替换链接本身,外部文件不变', async () => {
    const { ws, outside } = await setup();
    const target = join(ws, 'README.md');
    await symlink(outside, target);
    await writeBinaryHandler({ path: target, content: bytes('ssh-ed25519 ATTACKER\n') });
    expect(await readFile(outside, 'utf8')).toBe('ssh-ed25519 VICTIM\n');
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('ssh-ed25519 ATTACKER\n');
  });

  it('同名普通文件 → 照旧静默原子覆盖(产品行为不变)', async () => {
    const { ws } = await setup();
    const target = join(ws, 'a.bin');
    await writeFile(target, 'old', 'utf8');
    await writeBinaryHandler({ path: target, content: bytes('new') });
    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it('对照:编辑器保存 fs:write-file 仍写穿链接(读写对称语义不变)', async () => {
    const { ws, outside } = await setup();
    const target = join(ws, 'note.md');
    await symlink(outside, target);
    await writeFileHandler({ path: target, content: 'edited' });
    expect(await readFile(outside, 'utf8')).toBe('edited');
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
  });
});
