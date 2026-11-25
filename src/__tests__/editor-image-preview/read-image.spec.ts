// 主进程读图(fs:read-image):格式白名单、50 MiB 上限、workspaceOnly 的字面 + realpath 工作区判定。行为见同目录 README。
import { mkdir, symlink, truncate, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readImage } from '../../../electron/main/ipc/fs/read-image';
import { MAX_IMAGE_PREVIEW_BYTES } from '../../../electron/shared/image-preview';
import { setupTempDirs } from '../_helpers/tmp-dir';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  shell: {},
}));

const tmp = setupTempDirs();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return 'resolved';
}

describe('readImage', () => {
  it('png → data URL(MIME 按扩展名)+ 字节数', async () => {
    const d = await tmp.make('continuo-img-');
    const f = join(d, 'Logo.PNG');
    await writeFile(f, PNG);
    const r = await readImage(f);
    expect(r.dataUrl).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`);
    expect(r.size).toBe(PNG.length);
  });

  it('非可预览图片扩展名(txt / svg)→ FS_DENIED,不读', async () => {
    const d = await tmp.make('continuo-img-');
    for (const name of ['a.txt', 'a.svg']) {
      const f = join(d, name);
      await writeFile(f, 'x');
      expect(await codeOf(readImage(f))).toBe('FS_DENIED');
    }
  });

  it('超过 50 MiB → FS_FILE_TOO_LARGE', async () => {
    const d = await tmp.make('continuo-img-');
    const f = join(d, 'big.png');
    await writeFile(f, '');
    await truncate(f, MAX_IMAGE_PREVIEW_BYTES + 1);
    expect(await codeOf(readImage(f))).toBe('FS_FILE_TOO_LARGE');
  });

  it('不存在 → FS_NOT_FOUND', async () => {
    const d = await tmp.make('continuo-img-');
    expect(await codeOf(readImage(join(d, 'none.png')))).toBe('FS_NOT_FOUND');
  });

  describe('workspaceOnly(传工作区根)', () => {
    it('工作区内 → 读出', async () => {
      const root = await tmp.make('continuo-ws-');
      await mkdir(join(root, 'docs'));
      const f = join(root, 'docs', 'q.png');
      await writeFile(f, PNG);
      expect((await readImage(f, root)).size).toBe(PNG.length);
    });

    it('工作区外(含 .. 逃逸)/ 无工作区 → FS_DENIED', async () => {
      const root = await tmp.make('continuo-ws-');
      const outside = await tmp.make('continuo-out-');
      const f = join(outside, 'q.png');
      await writeFile(f, PNG);
      expect(await codeOf(readImage(f, root))).toBe('FS_DENIED');
      // 字面 `..` 逃逸(不 normalize 的拼接)
      expect(await codeOf(readImage(`${root}/../${basename(outside)}/q.png`, root))).toBe('FS_DENIED');
      expect(await codeOf(readImage(f, null))).toBe('FS_DENIED');
    });

    // Windows 建符号链接需管理员权限
    it.skipIf(process.platform === 'win32')('工作区内的符号链接指向工作区外 → FS_DENIED(realpath 判定)', async () => {
      const root = await tmp.make('continuo-ws-');
      const outside = await tmp.make('continuo-out-');
      const target = join(outside, 'secret.png');
      await writeFile(target, PNG);
      const link = join(root, 'q.png');
      await symlink(target, link);
      expect(await codeOf(readImage(link, root))).toBe('FS_DENIED');
    });
  });
});
