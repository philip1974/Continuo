import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile as fspReadFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalizePath } from '../../../electron/main/ipc/fs/path-utils';
import { listDir, sortDirsFirst } from '../../../electron/main/ipc/fs/list-dir';
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

  // 数据安全/正确性(codex 复查 P2):followSymlinks:true 时旧实现仍 lstat link 本身,
  // symlink-to-directory 永远 isDirectory=false → 不递归 → 静默漏掉链接目录下的文件。
  // 改 stat(跟随到目标)后,symlink 目录被正确识别并递归。MAX_DEPTH_HARD_LIMIT 界定环。
  it('followSymlinks:true 跟随 symlink 目录并递归(否则静默漏文件)', async () => {
    await mkdir(path.join(dir, 'target'));
    await writeFile(path.join(dir, 'target', 'deep.txt'), 'D');
    await symlink(path.join(dir, 'target'), path.join(dir, 'link'));

    const items = await listDir(dir, { maxDepth: 2, followSymlinks: true });
    const names = items.map((i) => i.name);
    // link 被识别为目录并递归 → deep.txt 出现
    expect(names).toContain('deep.txt');
    // link 仍标记 isSymlink(UI 可区分)
    expect(items.find((i) => i.name === 'link')?.isSymlink).toBe(true);
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

  it('sortDirsFirst 输入已是目录优先且按名称排序时不调用 sort', () => {
    const entries = [
      { path: '/p/a-dir', name: 'a-dir', isDirectory: true },
      { path: '/p/b-dir', name: 'b-dir', isDirectory: true },
      { path: '/p/a.txt', name: 'a.txt', isDirectory: false },
      { path: '/p/b.txt', name: 'b.txt', isDirectory: false },
    ];
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(sortDirsFirst(entries)).toBe(entries);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('FileEntry 字段含 path / name / isDirectory', async () => {
    const items = await listDir(dir);
    const sub = items.find((i) => i.name === 'sub');
    expect(sub).toBeDefined();
    expect(sub!.isDirectory).toBe(true);
    expect(sub!.path).toBe(path.join(dir, 'sub'));
  });

  it('perf P3 · 并发分块 lstat:宽目录(>1 块)不乱序、不漏项', async () => {
    // 建 70 个文件(>2×LSTAT_CHUNK=32),覆盖块边界。名字零填充保证字母序确定。
    const wide = path.join(dir, 'wide');
    await mkdir(wide);
    const n = 70;
    for (let i = 0; i < n; i++) {
      await writeFile(path.join(wide, `f${String(i).padStart(3, '0')}.txt`), '');
    }
    const items = await listDir(wide, { maxDepth: 1 });
    const names = items.map((i) => i.name);
    // 全部 70 个都在,且与同步排序结果一致(并发不破坏最终顺序)
    expect(names.length).toBe(n);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    // 无重复 / 无丢失
    expect(new Set(names).size).toBe(n);
  });

  it('perf P2 · maxFiles 早停:收集够 N 个文件即停,目录不计入', async () => {
    // beforeEach 已建:sub/(dir) + a.txt + b.txt + sub/inner.txt(深度内共 3 文件)。
    // 再多铺几个文件确保超过上限。
    await writeFile(path.join(dir, 'c.txt'), 'C');
    await writeFile(path.join(dir, 'd.txt'), 'D');
    const items = await listDir(dir, { maxDepth: 2, maxFiles: 2 });
    const files = items.filter((i) => !i.isDirectory);
    // 只收集到 2 个文件即停(目录不计入 maxFiles)
    expect(files.length).toBe(2);
  });

  it('perf P2 · maxFiles 未达上限 → 结果与不传 maxFiles 完全一致(行为保持)', async () => {
    const withCap = await listDir(dir, { maxDepth: 2, maxFiles: 9999 });
    const without = await listDir(dir, { maxDepth: 2 });
    expect(withCap.map((i) => i.path)).toEqual(without.map((i) => i.path));
  });

  // 边界(E275):list-dir 内部自守 —— 不安全整数/非有限 maxFiles(绕过 schema 直调 helper)按非法处理走
  // 默认硬上限(等同不传),不当成有效正数。结果与不传一致(不崩、不因 1e308 当 Infinity 异常)。
  it('E275 maxFiles 不安全整数(1e308)→ 按默认硬上限,结果与不传一致(不崩)', async () => {
    const evil = await listDir(dir, {
      maxDepth: 2,
      maxFiles: 1e308 as number,
    });
    const without = await listDir(dir, { maxDepth: 2 });
    expect(evil.map((i) => i.path)).toEqual(without.map((i) => i.path));
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

  // 边界(E38,plugin-fs E30 主侧 twin):总条目(文件+目录)硬上限,默认 100k,超过即抛
  // FS_DIR_TOO_LARGE(不静默截断)。maxFiles(只数文件、早停返部分)是正交的更低业务上限。
  it('E38 总条目超硬上限 → FS_DIR_TOO_LARGE(文件+目录都计数)', async () => {
    // 顶层非排除项 3 个:sub(目录)+ a.txt + b.txt;maxTotalEntries=2 → 第 3 项触发。
    await expectErrCode(
      () => listDir(dir, { maxTotalEntries: 2 }),
      'FS_DIR_TOO_LARGE',
    );
  });

  it('E38 默认硬上限下正常目录不受影响(行为保持)', async () => {
    const items = await listDir(dir);
    expect(items.map((i) => i.name).sort()).toEqual(['a.txt', 'b.txt', 'sub']);
  });

  it('E38 恰好等于上限 → 不抛(> 才触发,边界正确)', async () => {
    // 3 个条目,maxTotalEntries=3 → totalCount 到 3 不超过 3,不抛。
    const items = await listDir(dir, { maxTotalEntries: 3 });
    expect(items).toHaveLength(3);
  });

  // 边界(E211,E206-E210 有界迭代族):listDir 用 opendir 流式读取(Dir 内部 bufferSize 缓冲),
  // 不用 readdir 一次性把整目录所有 dirent 物化进主进程数组 —— 超宽目录否则在 MAX_TOTAL_ENTRIES
  // 检查前内存峰值/OOM。行为结果与 readdir 相同(node:fs/promises 导出不可 spy),故静态源码守卫
  // 验"用 opendir 流式、不用 readdir 全量"(E146/E190 同模式)+ 行为回归。
  it('E211 list-dir 源码用 opendir 流式,不用 readdir 全量物化整目录', async () => {
    const src = readFileSync(
      path.join(process.cwd(), 'electron/main/ipc/fs/list-dir.ts'),
      'utf-8',
    );
    expect(src).toMatch(/\bopendir\(/); // 改用 opendir 流式
    expect(src).not.toMatch(/\breaddir\(/); // 不再 readdir 全量物化(中和回 readdir → 含 readdir( → 失败)
    // 行为回归:正常列目录
    await writeFile(path.join(dir, 'a.txt'), 'a');
    const items = await listDir(dir);
    expect(items.some((i) => i.name === 'a.txt')).toBe(true);
  });

  it('perf · list-dir 块内 lstat Promise 预分配,不用 batch.map 回调分配', () => {
    const src = readFileSync(
      path.join(process.cwd(), 'electron/main/ipc/fs/list-dir.ts'),
      'utf-8',
    );
    expect(src).toMatch(
      /new Array<Promise<ResolvedEntry \| null>>\(batchCount\)/,
    );
    expect(src).not.toMatch(/batch\.map\(/);
    expect(src).not.toContain('chunk.push(');
    expect(src).not.toContain('out.push(...children)');
    expect(src).not.toContain('out.push({');
    expect(src).not.toContain('[...entries].sort(');
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

  // 边界(E18,E13 读侧对偶):超 64MiB 文件读前 stat.size 拦截,抛 FS_FILE_TOO_LARGE,不整文件
  // 读入内存。用稀疏 truncate 扩展到 >64MiB(不实际写 64MB),size 检查在 fspReadFile 之前。
  it('E18 超 64MiB → FS_FILE_TOO_LARGE(读前拦截)', async () => {
    const f = path.join(dir, 'huge.txt');
    await writeFile(f, 'x');
    await truncate(f, 64 * 1024 * 1024 + 1); // 稀疏扩展,不写 64MB 实际数据
    await expectErrCode(() => readFile(f), 'FS_FILE_TOO_LARGE');
  });

  // 边界(E163,stat-before-read 族 symlink 变体):此前 lstat(link).size 是链接自身(很小),
  // 但 readFile 跟随 symlink 读超大目标 → 绕过 cap。readFileCappedFd 经 open 跟随 symlink + fstat
  // 目标真实大小 → 超限抛 FS_FILE_TOO_LARGE。
  it('E163 symlink 指向超大目标 → FS_FILE_TOO_LARGE(跟随 symlink 查目标大小)', async () => {
    const target = path.join(dir, 'huge-target.bin');
    await writeFile(target, 'x');
    await truncate(target, 64 * 1024 * 1024 + 1); // 稀疏超大目标
    const link = path.join(dir, 'small-link');
    await symlink(target, link); // 链接自身很小,lstat.size ≈ target 路径长度
    await expectErrCode(() => readFile(link), 'FS_FILE_TOO_LARGE');
  });

  it('E163 symlink 指向正常小文件 → 正常读取(回归)', async () => {
    const target = path.join(dir, 'small-target.txt');
    await writeFile(target, 'via link 世界');
    const link = path.join(dir, 'ok-link');
    await symlink(target, link);
    expect(await readFile(link)).toBe('via link 世界');
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
