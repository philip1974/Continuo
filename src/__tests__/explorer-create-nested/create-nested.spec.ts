// BDD:新建文件 / 文件夹时一次输入嵌套路径(README 规则 1-4)。真实临时目录驱动 main 端 createFile / createDir。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDir, createFile } from '../../../electron/main/ipc/fs/create';
import { splitRelativeName } from '../../../electron/shared/leaf-name';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'continuo-create-nested-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe('splitRelativeName(规则 1)', () => {
  it('按 / 与 \\ 拆段', () => {
    expect(splitRelativeName('a.ts')).toEqual(['a.ts']);
    expect(splitRelativeName('na/nb/nc.ts')).toEqual(['na', 'nb', 'nc.ts']);
    expect(splitRelativeName('na\\nb\\nc.ts')).toEqual(['na', 'nb', 'nc.ts']);
  });

  it('拒:.. / . / 空段(绝对路径、UNC、a//b、结尾分隔符)/ 盘符 / 非 string', () => {
    for (const bad of ['../x', 'a/../x', './x', '/abs/x', '\\\\srv\\x', 'a//b', 'a/', '', 'C:\\x', 'C:/x']) {
      expect(splitRelativeName(bad), bad).toBeNull();
    }
    expect(splitRelativeName(42)).toBeNull();
  });
});

describe('createFile 嵌套路径(规则 2-3)', () => {
  it('na/nb/nc.ts:逐级建出中间目录与空文件;created = 最上层新建目录', async () => {
    const r = await createFile(dir, 'na/nb/nc.ts');
    expect(r).toEqual({ path: path.join(dir, 'na', 'nb', 'nc.ts'), created: path.join(dir, 'na') });
    expect(statSync(r.path).isFile()).toBe(true);
  });

  it('中间目录已存在:沿用,created = 第一个本次新建的项', async () => {
    await mkdir(path.join(dir, 'na'));
    const r = await createFile(dir, 'na/nb/nc.ts');
    expect(r.created).toBe(path.join(dir, 'na', 'nb'));
    const all = await createFile(dir, 'na/nb/other.ts');
    expect(all).toEqual({ path: path.join(dir, 'na', 'nb', 'other.ts'), created: path.join(dir, 'na', 'nb', 'other.ts') });
  });

  it('\\ 也是分隔符', async () => {
    const r = await createFile(dir, 'wa\\wb.ts');
    expect(r.path).toBe(path.join(dir, 'wa', 'wb.ts'));
  });

  it('目标已存在 → FS_EEXIST,既有文件不动', async () => {
    await createFile(dir, 'keep/x/y.ts');
    expect(await codeOf(createFile(dir, 'keep/x/y.ts'))).toBe('FS_EEXIST');
    expect(existsSync(path.join(dir, 'keep', 'x', 'y.ts'))).toBe(true);
  });

  it('建出中间目录后最后一步失败(文件名超出文件系统上限)→ 本次建出的中间目录回滚,已存在的不动', async () => {
    await mkdir(path.join(dir, 'keep'));
    const tooLong = `${'n'.repeat(254)}.ts`; // 257 字符:leaf 规则放行(≤260),文件系统拒(>255)
    const code = await codeOf(createFile(dir, `keep/m1/m2/${tooLong}`));
    expect(code).toBeDefined();
    expect(code).not.toBe('FS_BAD_NAME'); // 确是建出中间目录之后才失败
    expect(existsSync(path.join(dir, 'keep', 'm1'))).toBe(false);
    expect(statSync(path.join(dir, 'keep')).isDirectory()).toBe(true);
  });

  it('中间段是已存在的文件 → FS_NOT_DIRECTORY,不建任何东西', async () => {
    await writeFile(path.join(dir, 'f'), 'x');
    expect(await codeOf(createFile(dir, 'f/z.ts'))).toBe('FS_NOT_DIRECTORY');
    expect(await readdir(dir)).toEqual(['f']);
  });

  it('非法段(..、空段、绝对路径)→ FS_BAD_NAME,磁盘不动', async () => {
    for (const bad of ['../esc.ts', 'a/../../esc.ts', '/abs.ts', 'a//b.ts', 'a/b/']) {
      expect(await codeOf(createFile(dir, bad)), bad).toBe('FS_BAD_NAME');
    }
    expect(await readdir(dir)).toEqual([]);
    expect(existsSync(path.join(path.dirname(dir), 'esc.ts'))).toBe(false);
    expect(existsSync('/abs.ts')).toBe(false);
  });
});

describe('createDir 嵌套路径(规则 2-3)', () => {
  it('a/b:逐级建出;created = a', async () => {
    const r = await createDir(dir, 'a/b');
    expect(r).toEqual({ path: path.join(dir, 'a', 'b'), created: path.join(dir, 'a') });
    expect(statSync(r.path).isDirectory()).toBe(true);
  });

  it('最后一段已存在 → FS_EEXIST,已存在的目录不动', async () => {
    await mkdir(path.join(dir, 'a'));
    await mkdir(path.join(dir, 'a', 'b'));
    expect(await codeOf(createDir(dir, 'a/b'))).toBe('FS_EEXIST');
    expect(statSync(path.join(dir, 'a', 'b')).isDirectory()).toBe(true);
  });
});
