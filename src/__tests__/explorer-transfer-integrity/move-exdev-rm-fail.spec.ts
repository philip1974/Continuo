// 跨盘移动(EXDEV)fallback:cp 成功但 rm(src) 失败 → 必须报错,不得宣告移动成功。
//
// 根因:旧实现只 console.warn 并返回成功 → renderer 按移动成功处理(改 editor tab 路径、剪除剪贴板),
// 但源仍在(可能还被部分删除)。修:映射 rm 的 errno 抛出,消息说明目标已复制但源未能完全删除;
// renderer 失败分支仍刷新目标目录与源父目录,让已复制的内容可见。
import { mkdtemp, readFile, rm as realRm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});

const fsp = await import('node:fs/promises');
const { moveEntry } = await import('../../../electron/main/ipc/fs/move-copy');
const { transferEntriesInto } = await import('../../panels/Explorer/batch-transfer');

const dirs: string[] = [];
afterEach(async () => {
  vi.mocked(fsp.rename).mockReset();
  vi.mocked(fsp.rm).mockReset();
  for (const d of dirs.splice(0)) await realRm(d, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('moveEntry — EXDEV fallback rm 失败', () => {
  it('cp 成功 + rm 失败 → 抛映射后的 errno(FS_DENIED),消息说明目标已复制、源未完全删除', async () => {
    const d = await mkdtemp(join(tmpdir(), 'continuo-exdev-'));
    dirs.push(d);
    const src = join(d, 'src.txt');
    const dst = join(d, 'dst.txt');
    await writeFile(src, 'SRC');
    vi.mocked(fsp.rename).mockRejectedValueOnce(errno('EXDEV'));
    vi.mocked(fsp.rm).mockRejectedValueOnce(errno('EACCES'));

    const err = await moveEntry(src, dst).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    );
    expect(err?.code).toBe('FS_DENIED');
    expect(err?.message).toMatch(/copied/i);
    expect(err?.message).toMatch(/source/i);
    // 目标已就位,源仍在(未被静默当成移走)
    expect(await readFile(dst, 'utf-8')).toBe('SRC');
    expect(await readFile(src, 'utf-8')).toBe('SRC');
  });

  it('cp + rm 都成功 → 正常完成', async () => {
    const d = await mkdtemp(join(tmpdir(), 'continuo-exdev-'));
    dirs.push(d);
    const src = join(d, 'src.txt');
    const dst = join(d, 'dst.txt');
    await writeFile(src, 'SRC');
    vi.mocked(fsp.rename).mockRejectedValueOnce(errno('EXDEV'));

    await expect(moveEntry(src, dst)).resolves.toBeUndefined();
    expect(await readFile(dst, 'utf-8')).toBe('SRC');
  });
});

describe('transferEntriesInto — 某项失败仍刷新目标与源父目录', () => {
  it('首项 move 失败(目标可能已部分写入)→ 刷新目标目录 + 源父目录,但不当成已移走', async () => {
    const refreshDir = vi.fn();
    const onSourcesGone = vi.fn();
    const onMoved = vi.fn();
    await transferEntriesInto('move', ['/a/x'], '/dest', {
      fs: {
        move: async () => ({ ok: false, code: 'FS_DENIED', message: 'copied but source remains' }),
        copy: vi.fn(),
      } as never,
      makeUniqueDestPicker: async (dir) => (name) => `${dir}/${name}`,
      refreshDir,
      onMoved,
      onSourcesGone,
      onItemFailed: vi.fn(),
      onException: vi.fn(),
    });
    expect(refreshDir.mock.calls.map((c) => c[0]).sort()).toEqual(['/a', '/dest']);
    expect(onMoved).not.toHaveBeenCalled();
    expect(onSourcesGone).not.toHaveBeenCalled();
  });
});
