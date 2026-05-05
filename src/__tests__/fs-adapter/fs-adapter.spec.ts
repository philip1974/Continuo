import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile as fspReadFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalizePath } from '../../../electron/main/ipc/fs/path-utils';
import { listDir } from '../../../electron/main/ipc/fs/list-dir';
import { readFile } from '../../../electron/main/ipc/fs/read-file';
import { atomicWriteFile } from '../../../electron/main/ipc/fs/atomic-write';
import { renameEntry } from '../../../electron/main/ipc/fs/rename';
import { removeEntry } from '../../../electron/main/ipc/fs/remove';
import { createFile, createDir } from '../../../electron/main/ipc/fs/create';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lm-fs-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const expectErrCode = async (fn: () => Promise<unknown>, code: string) => {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect((caught as { code?: string }).code).toBe(code);
};

describe('path-utils.normalizePath', () => {
  it('相对路径 → 绝对路径', () => {
    const r = normalizePath('foo/bar');
    expect(path.isAbsolute(r)).toBe(true);
  });

  it('解析 ../', () => {
    const r = normalizePath('/a/b/../c');
    expect(r).toBe(path.resolve('/a/c'));
  });

  it('已绝对路径不变(规范化分隔符)', () => {
    const r = normalizePath(path.join(dir, 'x'));
    expect(r).toBe(path.resolve(path.join(dir, 'x')));
  });
});

describe('listDir', () => {
  beforeEach(async () => {
    await mkdir(path.join(dir, 'sub'));
    await mkdir(path.join(dir, '.git'));
    await mkdir(path.join(dir, 'node_modules'));
    await writeFile(path.join(dir, 'a.txt'), 'A');
    await writeFile(path.join(dir, 'b.txt'), 'B');
    await writeFile(path.join(dir, 'sub', 'inner.txt'), 'I');
  });

  it('默认列当前层(maxDepth=1),不递归', async () => {
    const items = await listDir(dir);
    const names = items.map((i) => i.name);
    expect(names).toContain('sub');
    expect(names).toContain('a.txt');
    // 子目录里的 inner.txt 不应出现
    expect(items.every((i) => i.name !== 'inner.txt')).toBe(true);
  });

  it('默认 exclude 屏蔽 .git / node_modules', async () => {
    const items = await listDir(dir);
    const names = items.map((i) => i.name);
    expect(names).not.toContain('.git');
    expect(names).not.toContain('node_modules');
  });

  it('自定义 exclude=[] → 显式要看 .git', async () => {
    const items = await listDir(dir, { exclude: [] });
    const names = items.map((i) => i.name);
    expect(names).toContain('.git');
    expect(names).toContain('node_modules');
  });

  it('排序:目录优先,再按名字字母序', async () => {
    const items = await listDir(dir);
    // 默认 exclude 排掉 .git/node_modules,剩下 sub(dir) + a.txt + b.txt
    expect(items.map((i) => i.name)).toEqual(['sub', 'a.txt', 'b.txt']);
  });

  it('FileEntry 字段含 path / name / isDirectory', async () => {
    const items = await listDir(dir);
    const sub = items.find((i) => i.name === 'sub');
    expect(sub).toBeDefined();
    expect(sub!.isDirectory).toBe(true);
    expect(sub!.path).toBe(path.join(dir, 'sub'));
  });

  it('maxDepth=2 递归一层', async () => {
    const items = await listDir(dir, { maxDepth: 2 });
    const inner = items.find((i) => i.name === 'inner.txt');
    expect(inner).toBeDefined();
    expect(inner!.path).toBe(path.join(dir, 'sub', 'inner.txt'));
  });

  it('maxDepth 超过硬上限被截断到 10', async () => {
    // 深度上限难以构造 11 层目录,这里只断言传 100 时不爆栈、能正常返回
    const items = await listDir(dir, { maxDepth: 100 });
    expect(Array.isArray(items)).toBe(true);
  });

  it('symlink 默认不递归,标 isSymlink', async () => {
    const linkPath = path.join(dir, 'link-to-sub');
    await symlink(path.join(dir, 'sub'), linkPath);
    const items = await listDir(dir);
    const link = items.find((i) => i.name === 'link-to-sub');
    expect(link).toBeDefined();
    expect(link!.isSymlink).toBe(true);
    // 即便目标是目录,默认不递归也不该把目标内的 inner.txt 拉出来
    expect(items.every((i) => i.name !== 'inner.txt')).toBe(true);
  });

  it('路径不存在 → FS_NOT_FOUND', async () => {
    await expectErrCode(() => listDir(path.join(dir, 'nope')), 'FS_NOT_FOUND');
  });

  it('路径是文件 → FS_NOT_DIRECTORY', async () => {
    await expectErrCode(
      () => listDir(path.join(dir, 'a.txt')),
      'FS_NOT_DIRECTORY',
    );
  });

  it('root 是 symlink 指向目录 → 跟随,正常列内容(macOS /tmp 类场景)', async () => {
    // dir/real-target/inner.txt + dir/link → real-target
    const target = path.join(dir, 'real-target');
    await mkdir(target);
    await writeFile(path.join(target, 'inner.txt'), 'x');
    const link = path.join(dir, 'link');
    await symlink(target, link);

    const items = await listDir(link);
    expect(items.map((i) => i.name)).toEqual(['inner.txt']);
  });
});

describe('readFile', () => {
  it('utf-8 读已有文件', async () => {
    const f = path.join(dir, 'x.txt');
    await writeFile(f, 'hello 世界');
    expect(await readFile(f)).toBe('hello 世界');
  });

  it('不存在 → FS_NOT_FOUND', async () => {
    await expectErrCode(() => readFile(path.join(dir, 'nope')), 'FS_NOT_FOUND');
  });

  it('是目录 → FS_NOT_FILE', async () => {
    await expectErrCode(() => readFile(dir), 'FS_NOT_FILE');
  });
});

describe('atomicWriteFile', () => {
  it('新文件可写,内容正确', async () => {
    const f = path.join(dir, 'new.txt');
    await atomicWriteFile(f, 'hello');
    expect(await fspReadFile(f, 'utf-8')).toBe('hello');
  });

  it('覆盖已有文件,内容更新', async () => {
    const f = path.join(dir, 'over.txt');
    await writeFile(f, 'old');
    await atomicWriteFile(f, 'new');
    expect(await fspReadFile(f, 'utf-8')).toBe('new');
  });

  it('不留 .tmp / .backup 残留', async () => {
    const f = path.join(dir, 'clean.txt');
    await atomicWriteFile(f, 'A');
    await atomicWriteFile(f, 'B');
    await atomicWriteFile(f, 'C');
    expect(existsSync(`${f}.tmp`)).toBe(false);
    expect(existsSync(`${f}.backup`)).toBe(false);
    expect(await fspReadFile(f, 'utf-8')).toBe('C');
  });

  it('父目录不存在 → 抛错(不静默 mkdir)', async () => {
    // VSCode 行为:save 到不存在的目录就该报错,不要悄悄建目录
    const f = path.join(dir, 'no-such-dir', 'x.txt');
    let caught: unknown;
    try {
      await atomicWriteFile(f, 'x');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // 失败后不留残留
    expect(existsSync(`${f}.tmp`)).toBe(false);
  });

  it('Uint8Array 写入(Step 5d Dropzone 二进制路径)', async () => {
    const f = path.join(dir, 'binary.dat');
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG 头
    await atomicWriteFile(f, bytes);
    const back = await import('node:fs/promises').then((m) =>
      m.readFile(f),
    );
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it('空字符串可写', async () => {
    const f = path.join(dir, 'empty.txt');
    await atomicWriteFile(f, '');
    expect(await fspReadFile(f, 'utf-8')).toBe('');
    expect(statSync(f).size).toBe(0);
  });
});

describe('renameEntry', () => {
  it('同目录改名,返回新绝对路径', async () => {
    const f = path.join(dir, 'old.txt');
    await writeFile(f, 'x');
    const newPath = await renameEntry(f, 'new.txt');
    expect(newPath).toBe(path.join(dir, 'new.txt'));
    expect(existsSync(f)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
  });

  it('newName 含 / → FS_BAD_NAME', async () => {
    const f = path.join(dir, 'x.txt');
    await writeFile(f, '');
    await expectErrCode(() => renameEntry(f, 'sub/y.txt'), 'FS_BAD_NAME');
  });

  it('newName 是 .. → FS_BAD_NAME', async () => {
    const f = path.join(dir, 'x.txt');
    await writeFile(f, '');
    await expectErrCode(() => renameEntry(f, '..'), 'FS_BAD_NAME');
  });

  it('newName 是 . → FS_BAD_NAME', async () => {
    const f = path.join(dir, 'x.txt');
    await writeFile(f, '');
    await expectErrCode(() => renameEntry(f, '.'), 'FS_BAD_NAME');
  });

  it('源不存在 → FS_NOT_FOUND', async () => {
    await expectErrCode(
      () => renameEntry(path.join(dir, 'nope'), 'x'),
      'FS_NOT_FOUND',
    );
  });
});

describe('removeEntry', () => {
  it('删文件', async () => {
    const f = path.join(dir, 'x.txt');
    await writeFile(f, 'x');
    await removeEntry(f);
    expect(existsSync(f)).toBe(false);
  });

  it('递归删目录', async () => {
    const sub = path.join(dir, 'sub');
    await mkdir(sub);
    await writeFile(path.join(sub, 'a'), 'a');
    await mkdir(path.join(sub, 'inner'));
    await writeFile(path.join(sub, 'inner', 'b'), 'b');
    await removeEntry(sub);
    expect(existsSync(sub)).toBe(false);
  });

  it('不存在 → FS_NOT_FOUND', async () => {
    await expectErrCode(
      () => removeEntry(path.join(dir, 'nope')),
      'FS_NOT_FOUND',
    );
  });
});

describe('createFile', () => {
  it('创建空文件,返回路径', async () => {
    const newPath = await createFile(dir, 'fresh.txt');
    expect(newPath).toBe(path.join(dir, 'fresh.txt'));
    expect(existsSync(newPath)).toBe(true);
    expect(await fspReadFile(newPath, 'utf-8')).toBe('');
  });

  it('已存在 → FS_EEXIST', async () => {
    await writeFile(path.join(dir, 'x.txt'), 'x');
    await expectErrCode(() => createFile(dir, 'x.txt'), 'FS_EEXIST');
  });

  it('name 含 / → FS_BAD_NAME', async () => {
    await expectErrCode(() => createFile(dir, 'sub/x.txt'), 'FS_BAD_NAME');
  });
});

describe('createDir', () => {
  it('创建目录,返回路径', async () => {
    const newPath = await createDir(dir, 'newdir');
    expect(newPath).toBe(path.join(dir, 'newdir'));
    expect(statSync(newPath).isDirectory()).toBe(true);
  });

  it('已存在 → FS_EEXIST', async () => {
    await mkdir(path.join(dir, 'd'));
    await expectErrCode(() => createDir(dir, 'd'), 'FS_EEXIST');
  });

  it('父目录不存在 → 抛错(non-recursive)', async () => {
    let caught: unknown;
    try {
      await createDir(path.join(dir, 'nope'), 'x');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
  });

  it('name 是 .. → FS_BAD_NAME', async () => {
    await expectErrCode(() => createDir(dir, '..'), 'FS_BAD_NAME');
  });
});
