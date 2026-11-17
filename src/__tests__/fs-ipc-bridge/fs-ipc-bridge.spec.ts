import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile as fspReadFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FS_CHANNELS,
  toFsFileStat,
  toFsReadFileResult,
  toFsStatResult,
  toFsWriteFileResult,
} from '../../../electron/shared/fs-channels';
import {
  createDirHandler,
  createDirInputSchema,
  createFileHandler,
  createFileInputSchema,
  listDirHandler,
  listDirInputSchema,
  moveInputSchema,
  makeSelectDirectoryHandler,
  makeTrashHandler,
  readFileHandler,
  readFileInputSchema,
  removeHandler,
  removeInputSchema,
  renameHandler,
  renameInputSchema,
  selectDirectoryInputSchema,
  statHandler,
  statInputSchema,
  trashInputSchema,
  writeFileHandler,
  writeFileInputSchema,
  writeBinaryInputSchema,
} from '../../../electron/main/ipc/fs.ipc';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lm-fs-ipc-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────
// A. 通道常量表
// ────────────────────────────────────────────────────────────

describe('FS_CHANNELS 常量', () => {
  it('每条字符串与契约一致', () => {
    expect(FS_CHANNELS.LIST_DIR).toBe('fs:list-dir');
    expect(FS_CHANNELS.READ_FILE).toBe('fs:read-file');
    expect(FS_CHANNELS.WRITE_FILE).toBe('fs:write-file');
    expect(FS_CHANNELS.RENAME).toBe('fs:rename');
    expect(FS_CHANNELS.REMOVE).toBe('fs:remove');
    expect(FS_CHANNELS.CREATE_FILE).toBe('fs:create-file');
    expect(FS_CHANNELS.CREATE_DIR).toBe('fs:create-dir');
    expect(FS_CHANNELS.TRASH).toBe('fs:trash');
    expect(FS_CHANNELS.SELECT_DIRECTORY).toBe('fs:select-directory');
    expect(FS_CHANNELS.STAT).toBe('fs:stat');
  });

  it('9 条常量值唯一不重复', () => {
    const values = Object.values(FS_CHANNELS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('所有值满足 fs: 前缀', () => {
    for (const v of Object.values(FS_CHANNELS)) {
      expect(v.startsWith('fs:')).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────
// B. schemas — 正确入参通过 / 缺字段拒绝 / 类型错拒绝 / strict
// ────────────────────────────────────────────────────────────

describe('listDirInputSchema', () => {
  it('接受最简 { path }', () => {
    expect(listDirInputSchema.safeParse({ path: '/tmp' }).success).toBe(true);
  });
  it('接受 { path, options }', () => {
    expect(
      listDirInputSchema.safeParse({
        path: '/tmp',
        options: { maxDepth: 3, exclude: ['.git'], followSymlinks: true },
      }).success,
    ).toBe(true);
  });
  it('接受 options.withStats 布尔;非布尔 → fail', () => {
    expect(
      listDirInputSchema.safeParse({ path: '/tmp', options: { withStats: false } }).success,
    ).toBe(true);
    expect(
      listDirInputSchema.safeParse({ path: '/tmp', options: { withStats: 'no' } }).success,
    ).toBe(false);
  });
  it('缺 path → fail', () => {
    expect(listDirInputSchema.safeParse({}).success).toBe(false);
  });
  it('path 类型错 → fail', () => {
    expect(listDirInputSchema.safeParse({ path: 42 }).success).toBe(false);
  });
  it('options 含未知字段 → fail(strict)', () => {
    expect(
      listDirInputSchema.safeParse({
        path: '/x',
        options: { maxDepth: 1, weird: true },
      }).success,
    ).toBe(false);
  });
  it('maxDepth 非正整数 → fail', () => {
    expect(
      listDirInputSchema.safeParse({ path: '/x', options: { maxDepth: 0 } }).success,
    ).toBe(false);
    expect(
      listDirInputSchema.safeParse({ path: '/x', options: { maxDepth: -1 } }).success,
    ).toBe(false);
  });

  // 边界(E275):maxFiles 上界对齐 MAX_TOTAL_ENTRIES + 安全整数;畸形大值/不安全整数被 schema 拒。
  it('E275 maxFiles 在上限内 → ok,超 MAX_TOTAL_ENTRIES / 1e308 → fail', () => {
    expect(
      listDirInputSchema.safeParse({ path: '/x', options: { maxFiles: 1000 } })
        .success,
    ).toBe(true);
    expect(
      listDirInputSchema.safeParse({
        path: '/x',
        options: { maxFiles: 100_000 },
      }).success,
    ).toBe(true); // 恰好 MAX_TOTAL_ENTRIES
    expect(
      listDirInputSchema.safeParse({
        path: '/x',
        options: { maxFiles: 100_001 },
      }).success,
    ).toBe(false); // 超硬上限
    expect(
      listDirInputSchema.safeParse({ path: '/x', options: { maxFiles: 1e308 } })
        .success,
    ).toBe(false); // 不安全整数(此前 z.int() 放行)
    expect(
      listDirInputSchema.safeParse({ path: '/x', options: { maxFiles: 0 } })
        .success,
    ).toBe(false);
  });
  it('顶层未知字段 → fail(strict)', () => {
    expect(
      listDirInputSchema.safeParse({ path: '/x', extra: 1 }).success,
    ).toBe(false);
  });
});

describe('readFileInputSchema', () => {
  it('接受 { path }', () => {
    expect(readFileInputSchema.safeParse({ path: '/x' }).success).toBe(true);
  });
  it('缺 path → fail', () => {
    expect(readFileInputSchema.safeParse({}).success).toBe(false);
  });
  it('未知字段 → fail', () => {
    expect(readFileInputSchema.safeParse({ path: '/x', y: 1 }).success).toBe(false);
  });
});

describe('writeFileInputSchema', () => {
  it('接受 { path, content }', () => {
    expect(
      writeFileInputSchema.safeParse({ path: '/x', content: 'hi' }).success,
    ).toBe(true);
  });
  it('缺 content → fail', () => {
    expect(writeFileInputSchema.safeParse({ path: '/x' }).success).toBe(false);
  });
  it('content 非 string → fail', () => {
    expect(
      writeFileInputSchema.safeParse({ path: '/x', content: 123 }).success,
    ).toBe(false);
  });

  // 边界(E13):content 加 64MiB 上限(滥用/误操作 backstop),超限 → fail(走 BAD_INPUT)。
  it('E13 正常大小 content → ok;超 64MiB → fail', () => {
    const cap = 64 * 1024 * 1024;
    expect(
      writeFileInputSchema.safeParse({ path: '/x', content: 'x'.repeat(1000) })
        .success,
    ).toBe(true);
    expect(
      writeFileInputSchema.safeParse({
        path: '/x',
        content: 'x'.repeat(cap + 1),
      }).success,
    ).toBe(false);
  });
});

describe('writeBinaryInputSchema (E13)', () => {
  const cap = 64 * 1024 * 1024;
  it('正常 Uint8Array → ok', () => {
    expect(
      writeBinaryInputSchema.safeParse({
        path: '/x',
        content: new Uint8Array([1, 2, 3]),
      }).success,
    ).toBe(true);
  });
  it('content 非 Uint8Array → fail', () => {
    expect(
      writeBinaryInputSchema.safeParse({ path: '/x', content: 'hi' }).success,
    ).toBe(false);
  });
  it('超 64MiB → fail(滥用 backstop)', () => {
    expect(
      writeBinaryInputSchema.safeParse({
        path: '/x',
        content: new Uint8Array(cap + 1),
      }).success,
    ).toBe(false);
  });
});

// 边界(E21,E13 同族):fs IPC 的 path/newName/name/dir/src/dest/exclude 加长度与数量上限,
// 防超长路径/巨大 exclude 列表在 IPC/zod/扫描路径耗内存+CPU。
describe('E21 fs IPC 路径/名称/exclude 上限', () => {
  it('path 超 8192 → fail', () => {
    expect(
      readFileInputSchema.safeParse({ path: '/' + 'x'.repeat(8192) }).success,
    ).toBe(false);
    expect(
      removeInputSchema.safeParse({ path: '/' + 'x'.repeat(8192) }).success,
    ).toBe(false);
  });
  it('newName / name 超 1024 → fail', () => {
    expect(
      renameInputSchema.safeParse({ path: '/x', newName: 'x'.repeat(1025) })
        .success,
    ).toBe(false);
    expect(
      createFileInputSchema.safeParse({ dir: '/x', name: 'x'.repeat(1025) })
        .success,
    ).toBe(false);
  });
  it('src/dest 超 8192 → fail', () => {
    expect(
      moveInputSchema.safeParse({ src: '/' + 'x'.repeat(8192), dest: '/y' })
        .success,
    ).toBe(false);
  });
  it('listDir exclude 数量超 1000 → fail', () => {
    const exclude = Array.from({ length: 1001 }, (_, i) => `e${i}`);
    expect(
      listDirInputSchema.safeParse({ path: '/x', options: { exclude } }).success,
    ).toBe(false);
  });
  it('正常 path/name/exclude → ok', () => {
    expect(
      listDirInputSchema.safeParse({
        path: '/Users/me/proj',
        options: { exclude: ['.git', 'node_modules'] },
      }).success,
    ).toBe(true);
    expect(
      renameInputSchema.safeParse({ path: '/x/a.txt', newName: 'b.txt' })
        .success,
    ).toBe(true);
  });
});

describe('renameInputSchema', () => {
  it('接受 { path, newName }', () => {
    expect(renameInputSchema.safeParse({ path: '/x', newName: 'y' }).success).toBe(true);
  });
  it('缺字段 → fail', () => {
    expect(renameInputSchema.safeParse({ path: '/x' }).success).toBe(false);
    expect(renameInputSchema.safeParse({ newName: 'y' }).success).toBe(false);
  });
  it('newName 空字符串 → fail', () => {
    expect(renameInputSchema.safeParse({ path: '/x', newName: '' }).success).toBe(false);
  });
});

describe('removeInputSchema', () => {
  it('接受 { path }', () => {
    expect(removeInputSchema.safeParse({ path: '/x' }).success).toBe(true);
  });
  it('缺 path → fail', () => {
    expect(removeInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('createFileInputSchema', () => {
  it('接受 { dir, name }', () => {
    expect(createFileInputSchema.safeParse({ dir: '/x', name: 'a.txt' }).success).toBe(true);
  });
  it('缺字段 → fail', () => {
    expect(createFileInputSchema.safeParse({ dir: '/x' }).success).toBe(false);
    expect(createFileInputSchema.safeParse({ name: 'a' }).success).toBe(false);
  });
  it('name 空 → fail', () => {
    expect(createFileInputSchema.safeParse({ dir: '/x', name: '' }).success).toBe(false);
  });
});

describe('createDirInputSchema', () => {
  it('接受 { parent, name }', () => {
    expect(createDirInputSchema.safeParse({ parent: '/x', name: 'd' }).success).toBe(true);
  });
  it('缺字段 → fail', () => {
    expect(createDirInputSchema.safeParse({ parent: '/x' }).success).toBe(false);
  });
});

describe('trashInputSchema', () => {
  it('接受 { path }', () => {
    expect(trashInputSchema.safeParse({ path: '/x' }).success).toBe(true);
  });
  it('缺 path → fail', () => {
    expect(trashInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('selectDirectoryInputSchema', () => {
  it('接受 undefined', () => {
    expect(selectDirectoryInputSchema.safeParse(undefined).success).toBe(true);
  });
  it('不接受 {}(显式严格)', () => {
    expect(selectDirectoryInputSchema.safeParse({}).success).toBe(false);
  });
  it('不接受其他值', () => {
    expect(selectDirectoryInputSchema.safeParse('x').success).toBe(false);
    expect(selectDirectoryInputSchema.safeParse(0).success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// C. handler 接线 — 用临时目录跑真 fs,浅断言
// ────────────────────────────────────────────────────────────

describe('handlers 接线', () => {
  it('listDirHandler 透传 path 与 options', async () => {
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'a.txt'), 'a');
    await writeFile(path.join(dir, 'sub', 'inner.txt'), 'i');
    const items = await listDirHandler({ path: dir });
    expect(items.map((i) => i.name)).toEqual(['sub', 'a.txt']);

    const recursive = await listDirHandler({ path: dir, options: { maxDepth: 2 } });
    expect(recursive.some((i) => i.name === 'inner.txt')).toBe(true);
  });

  it('readFileHandler 返回 utf-8 内容(普通文件不带 realPath)', async () => {
    const f = path.join(dir, 'r.txt');
    await writeFile(f, 'hello');
    expect(await readFileHandler({ path: f })).toEqual({ content: 'hello' });
  });

  // 外部同步(dir-changed 按文件名匹配)需要知道 symlink tab 的真实目标:FSEvents/inotify 上报的是被
  // 实际修改的目录项(链接目标)名。leaf 为 symlink 时随结果带 realPath(与保存写穿同一套解析)。
  it('readFileHandler:leaf 为 symlink → 读目标内容并带 realPath(同目录 / 跨目录)', async () => {
    const canonical = await realpath(dir);
    await writeFile(path.join(dir, 'AGENTS.md'), 'agents');
    await symlink('AGENTS.md', path.join(dir, 'CLAUDE.md'));
    expect(await readFileHandler({ path: path.join(dir, 'CLAUDE.md') })).toEqual({
      content: 'agents',
      realPath: path.join(canonical, 'AGENTS.md'),
    });
    await mkdir(path.join(dir, 'other'));
    await writeFile(path.join(dir, 'other', 't.md'), 'far');
    await symlink(path.join(dir, 'other', 't.md'), path.join(dir, 'link.md'));
    expect(await readFileHandler({ path: path.join(dir, 'link.md') })).toEqual({
      content: 'far',
      realPath: path.join(canonical, 'other', 't.md'),
    });
  });

  it('writeFileHandler 落盘内容正确', async () => {
    const f = path.join(dir, 'w.txt');
    await writeFileHandler({ path: f, content: 'world' });
    expect(await fspReadFile(f, 'utf-8')).toBe('world');
  });

  // 性能(编辑器保存回声识别):写成功返回写入内容的 { mtimeMs, size, ino },与随后 fs:stat 一致。
  it('writeFileHandler 返回写入后的 { mtimeMs, size, ino },与 statHandler 一致', async () => {
    const f = path.join(dir, 'w.txt');
    const written = await writeFileHandler({ path: f, content: '世界' });
    const st = statSync(f);
    expect(written).toEqual({ mtimeMs: st.mtimeMs, size: st.size, ino: st.ino });
    expect(written?.size).toBe(6);
    expect(await statHandler({ path: f })).toEqual(written);
  });

  it('writeFileHandler 写穿 symlink:返回链接目标的 stat', async () => {
    const target = path.join(dir, 't.md');
    await writeFile(target, 'x');
    await symlink(target, path.join(dir, 'link.md'));
    const written = await writeFileHandler({ path: path.join(dir, 'link.md'), content: 'abc' });
    const st = statSync(target);
    expect(written).toEqual({ mtimeMs: st.mtimeMs, size: 3, ino: st.ino });
  });

  it('statHandler:不存在 → 抛 FS_NOT_FOUND;schema strict + 必填 path', async () => {
    await expect(statHandler({ path: path.join(dir, 'nope') })).rejects.toMatchObject({
      code: 'FS_NOT_FOUND',
    });
    expect(statInputSchema.safeParse({ path: '/a' }).success).toBe(true);
    expect(statInputSchema.safeParse({}).success).toBe(false);
    expect(statInputSchema.safeParse({ path: '/a', x: 1 }).success).toBe(false);
    expect(statInputSchema.safeParse({ path: 'a'.repeat(100_000) }).success).toBe(false);
  });

  it('preload 结果映射:stat 守卫 / writeFile 畸形 data → undefined / stat 畸形 → 失败', () => {
    expect(toFsFileStat({ mtimeMs: 1.5, size: 2, ino: 7, extra: 1 })).toEqual({
      mtimeMs: 1.5,
      size: 2,
      ino: 7,
    });
    expect(toFsFileStat({ mtimeMs: Number.NaN, size: 2, ino: 7 })).toBeUndefined();
    expect(toFsFileStat({ mtimeMs: 1, size: -1, ino: 7 })).toBeUndefined();
    expect(toFsFileStat({ mtimeMs: 1, size: 1.5, ino: 7 })).toBeUndefined();
    // ino 必填(粗粒度 mtime 文件系统上同大小外部替换靠它区分):缺省 / 非有限 / 负 → 不合规
    expect(toFsFileStat({ mtimeMs: 1, size: 2 })).toBeUndefined();
    expect(toFsFileStat({ mtimeMs: 1, size: 2, ino: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(toFsFileStat({ mtimeMs: 1, size: 2, ino: -1 })).toBeUndefined();
    expect(toFsFileStat({ mtimeMs: 1, size: 2, ino: '7' })).toBeUndefined();
    expect(toFsFileStat(null)).toBeUndefined();
    expect(toFsWriteFileResult({ ok: true, data: { mtimeMs: 1, size: 2, ino: 7 } })).toEqual({
      ok: true,
      data: { mtimeMs: 1, size: 2, ino: 7 },
    });
    expect(toFsWriteFileResult({ ok: true, data: 'bogus' })).toEqual({ ok: true, data: undefined });
    const fail = { ok: false as const, code: 'FS_IO', message: 'x' };
    expect(toFsWriteFileResult(fail)).toBe(fail);
    expect(toFsStatResult({ ok: true, data: { mtimeMs: 1, size: 2, ino: 7 } })).toEqual({
      ok: true,
      data: { mtimeMs: 1, size: 2, ino: 7 },
    });
    expect(toFsStatResult({ ok: true, data: {} }).ok).toBe(false);
    expect(toFsStatResult(fail)).toBe(fail);
  });

  it('renameHandler 同目录改名,返回新路径', async () => {
    const f = path.join(dir, 'old.txt');
    await writeFile(f, '');
    const np = await renameHandler({ path: f, newName: 'new.txt' });
    expect(np).toBe(path.join(dir, 'new.txt'));
    expect(existsSync(f)).toBe(false);
    expect(existsSync(np)).toBe(true);
  });

  it('removeHandler 删文件', async () => {
    const f = path.join(dir, 'x.txt');
    await writeFile(f, '');
    await removeHandler({ path: f });
    expect(existsSync(f)).toBe(false);
  });

  it('createFileHandler 建空文件,返回新路径', async () => {
    const np = await createFileHandler({ dir, name: 'fresh.txt' });
    expect(np).toBe(path.join(dir, 'fresh.txt'));
    expect(statSync(np).size).toBe(0);
  });

  it('createDirHandler 建目录,返回新路径', async () => {
    const np = await createDirHandler({ parent: dir, name: 'fresh' });
    expect(np).toBe(path.join(dir, 'fresh'));
    expect(statSync(np).isDirectory()).toBe(true);
  });

  it('handler 抛业务 code(由 safeHandle 透传,本主题只断言抛得出)', async () => {
    let caught: unknown;
    try {
      await readFileHandler({ path: path.join(dir, 'nope') });
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe('FS_NOT_FOUND');
  });
});

// ────────────────────────────────────────────────────────────
// D. trash / selectDirectory — 工厂注入 deps,不真接 Electron API
// ────────────────────────────────────────────────────────────

describe('makeTrashHandler', () => {
  it('用 deps.trashItem 处理 path', async () => {
    const trashItem = vi.fn(async () => {});
    const handler = makeTrashHandler({ trashItem });
    await handler({ path: '/foo/bar' });
    expect(trashItem).toHaveBeenCalledWith('/foo/bar');
  });

  it('deps.trashItem 抛错时透传', async () => {
    const handler = makeTrashHandler({
      trashItem: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    });
    let caught: unknown;
    try {
      await handler({ path: '/x' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
  });
});

describe('makeSelectDirectoryHandler', () => {
  // 显式标 mock 参数类型,确保 mock.calls[0][0] 类型可索引
  type DialogOpts = { properties: ReadonlyArray<string> };
  type DialogResult = { canceled: boolean; filePaths: ReadonlyArray<string> };

  it('cancelled → null', async () => {
    const showOpenDialog = vi.fn(
      async (_opts: DialogOpts): Promise<DialogResult> => ({
        canceled: true,
        filePaths: [],
      }),
    );
    const handler = makeSelectDirectoryHandler({ showOpenDialog });
    expect(await handler()).toBeNull();
  });

  it('选定 → 返回首个 filePaths', async () => {
    const showOpenDialog = vi.fn(
      async (_opts: DialogOpts): Promise<DialogResult> => ({
        canceled: false,
        filePaths: ['/Users/me/work', '/should-not-be-used'],
      }),
    );
    const handler = makeSelectDirectoryHandler({ showOpenDialog });
    expect(await handler()).toBe('/Users/me/work');
  });

  it('未取消但 filePaths 空 → null', async () => {
    const showOpenDialog = vi.fn(
      async (_opts: DialogOpts): Promise<DialogResult> => ({
        canceled: false,
        filePaths: [],
      }),
    );
    const handler = makeSelectDirectoryHandler({ showOpenDialog });
    expect(await handler()).toBeNull();
  });

  it('调 showOpenDialog 时 properties 含 openDirectory', async () => {
    const showOpenDialog = vi.fn(
      async (_opts: DialogOpts): Promise<DialogResult> => ({
        canceled: true,
        filePaths: [],
      }),
    );
    const handler = makeSelectDirectoryHandler({ showOpenDialog });
    await handler();
    expect(showOpenDialog).toHaveBeenCalledTimes(1);
    const arg = showOpenDialog.mock.calls[0]![0];
    expect(arg.properties).toContain('openDirectory');
  });
});

// ────────────────────────────────────────────────────────────
// E. preload 侧 readFile 结果映射:data 仍为 string(既有调用方不变),realPath 校验后可选附带
// ────────────────────────────────────────────────────────────

describe('toFsReadFileResult', () => {
  it('ok + realPath 合规 → { ok, data: content, realPath }', () => {
    expect(
      toFsReadFileResult({ ok: true, data: { content: 'x', realPath: '/r/a.md' } }, 100),
    ).toEqual({ ok: true, data: 'x', realPath: '/r/a.md' });
  });
  it('ok 无 realPath → 不带该字段', () => {
    expect(toFsReadFileResult({ ok: true, data: { content: 'x' } }, 100)).toEqual({
      ok: true,
      data: 'x',
    });
  });
  it('realPath 畸形 / 超长 → 丢弃 realPath(内容照常)', () => {
    for (const bad of [42, '', 'x'.repeat(101), null]) {
      const r = toFsReadFileResult(
        { ok: true, data: { content: 'x', realPath: bad as unknown as string } },
        100,
      );
      expect(r).toEqual({ ok: true, data: 'x' });
    }
  });
  it('失败结果原样透传', () => {
    const fail = { ok: false as const, code: 'FS_NOT_FOUND', message: 'nope' };
    expect(toFsReadFileResult(fail, 100)).toBe(fail);
  });
});
