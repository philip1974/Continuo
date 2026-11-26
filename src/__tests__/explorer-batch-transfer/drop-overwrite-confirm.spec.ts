// 外部(Finder)文件 drop 遇同名:写入前探测目标目录,同名文件先问「替换 / 跳过 / 取消」,不再静默覆盖(丢数据)。
// 对齐 VSCode ExternalFileImport / getFileOverwriteConfirm。判重与唯一名 picker 同一套大小写 + NFC 折叠。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from '../../lib/fs/types';

const h = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock('@/notifications/notify', () => ({ notify: { error: h.notifyError } }));

import {
  dropForeignFilesInto,
  type OverwriteChoice,
} from '../../panels/Explorer/batch-transfer';

function itemsOf(names: string[]): DataTransferItemList {
  const arr = names.map((name) => ({
    kind: 'file',
    type: '',
    getAsFile: () => new File([new Uint8Array([1])], name),
    webkitGetAsEntry: () => ({ isDirectory: false, name }),
  }));
  return Object.assign(arr, { length: arr.length }) as unknown as DataTransferItemList;
}

const entry = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  path: `/work/${name}`,
  name,
  isDirectory: false,
  ...extra,
});

function makeFs(existing: FileEntry[] | { fail: true }) {
  return {
    listDir: vi.fn(async () =>
      'fail' in existing
        ? { ok: false as const, code: 'FS_DENIED', message: 'denied' }
        : { ok: true as const, data: existing },
    ),
    writeBinary: vi.fn(async () => ({ ok: true as const, data: undefined })),
  };
}

const written = (fs: ReturnType<typeof makeFs>) =>
  fs.writeBinary.mock.calls.map((c) => (c as unknown as [string])[0]);

beforeEach(() => h.notifyError.mockReset());

describe('dropForeignFilesInto · 同名确认', () => {
  it('目标目录无同名 → 不询问,全部写入', async () => {
    const fs = makeFs([entry('other.txt')]);
    const confirm = vi.fn(async (_names: readonly string[], _canSkip: boolean): Promise<OverwriteChoice> => 'cancel');
    await dropForeignFilesInto(itemsOf(['a.txt', 'b.txt']), '/work', fs, vi.fn(), confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(written(fs)).toEqual(['/work/a.txt', '/work/b.txt']);
  });

  it('同名(大小写 + NFC 折叠)→ 先询问并列出冲突名;取消 → 一个都不写', async () => {
    const fs = makeFs([entry('Readme.md'), entry('café.txt')]);
    const confirm = vi.fn(async (_names: readonly string[], _canSkip: boolean): Promise<OverwriteChoice> => 'cancel');
    const refresh = vi.fn();
    await dropForeignFilesInto(
      itemsOf(['README.md', 'café.txt', 'new.txt']),
      '/work',
      fs,
      refresh,
      confirm,
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]).toEqual([['README.md', 'café.txt'], true]);
    expect(fs.writeBinary).not.toHaveBeenCalled();
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  it('替换 → 全部写入(含同名项)', async () => {
    const fs = makeFs([entry('a.txt')]);
    await dropForeignFilesInto(itemsOf(['a.txt', 'b.txt']), '/work', fs, vi.fn(), async () => 'replace');
    expect(written(fs)).toEqual(['/work/a.txt', '/work/b.txt']);
  });

  it('跳过 → 只写不冲突的项,同名的原文件不动', async () => {
    const fs = makeFs([entry('a.txt')]);
    await dropForeignFilesInto(itemsOf(['a.txt', 'b.txt']), '/work', fs, vi.fn(), async () => 'skip');
    expect(written(fs)).toEqual(['/work/b.txt']);
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  it('全部同名 → canSkip=false(跳过与取消等价,不提供)', async () => {
    const fs = makeFs([entry('a.txt')]);
    const confirm = vi.fn(async (_names: readonly string[], _canSkip: boolean): Promise<OverwriteChoice> => 'cancel');
    await dropForeignFilesInto(itemsOf(['a.txt']), '/work', fs, vi.fn(), confirm);
    expect(confirm.mock.calls[0]).toEqual([['a.txt'], false]);
  });

  it('同批多个同名文件只列一次', async () => {
    const fs = makeFs([entry('a.txt')]);
    const confirm = vi.fn(async (_names: readonly string[], _canSkip: boolean): Promise<OverwriteChoice> => 'cancel');
    await dropForeignFilesInto(itemsOf(['a.txt', 'A.txt']), '/work', fs, vi.fn(), confirm);
    expect(confirm.mock.calls[0]![0]).toEqual(['a.txt']);
  });

  it('与同名文件夹冲突 → 不提供替换(不能用文件替换文件夹),该项归失败提示,其余照写', async () => {
    const fs = makeFs([entry('src', { isDirectory: true })]);
    const confirm = vi.fn(async (_names: readonly string[], _canSkip: boolean): Promise<OverwriteChoice> => 'replace');
    await dropForeignFilesInto(itemsOf(['src', 'b.txt']), '/work', fs, vi.fn(), confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(written(fs)).toEqual(['/work/b.txt']);
    expect(h.notifyError).toHaveBeenCalledTimes(1);
    expect(String(h.notifyError.mock.calls[0]![0])).toContain('src: [FS_EEXIST]');
  });

  it('同名项是指向目录的符号链接 → 按可替换处理(替换的是链接本身)', async () => {
    const fs = makeFs([entry('link', { isDirectory: true, isSymlink: true })]);
    const confirm = vi.fn(async (_names: readonly string[], _canSkip: boolean): Promise<OverwriteChoice> => 'replace');
    await dropForeignFilesInto(itemsOf(['link']), '/work', fs, vi.fn(), confirm);
    expect(confirm.mock.calls[0]![0]).toEqual(['link']);
    expect(written(fs)).toEqual(['/work/link']);
  });

  it('目标目录读不到(无法判断同名)→ 不写入(fail-closed)并提示', async () => {
    const fs = makeFs({ fail: true });
    const confirm = vi.fn(async (_names: readonly string[], _canSkip: boolean): Promise<OverwriteChoice> => 'replace');
    await dropForeignFilesInto(itemsOf(['a.txt']), '/work', fs, vi.fn(), confirm);
    expect(fs.writeBinary).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(h.notifyError).toHaveBeenCalledTimes(1);
  });
});
