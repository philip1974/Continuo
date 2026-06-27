import { describe, it, expect } from 'vitest';
import {
  pickDroppedDirectory,
  resolveDroppedWorkspace,
  captureBoundedFiles,
  hasDirectoryInFirstItems,
  hasFiles,
  MAX_DROP_FILES,
} from '../../lib/window-drop';

// 边界(E189/E224,E176 有界遍历族):hasFiles 共享早停 helper(Terminal + App.tsx 全局 drop 共用单一来源)。
describe('hasFiles(E224)', () => {
  const mk = (types: readonly string[]) =>
    ({ types } as unknown as DataTransfer);
  it('types 含 Files → true;不含 → false;null → false', () => {
    expect(hasFiles(mk(['text/plain', 'Files']))).toBe(true);
    expect(hasFiles(mk(['text/plain', 'text/uri-list']))).toBe(false);
    expect(hasFiles(mk([]))).toBe(false);
    expect(hasFiles(null)).toBe(false);
  });
  it('命中即短路,不遍历 Files 之后的项(早停)', () => {
    const types = ['Files'] as string[];
    Object.defineProperty(types, 'length', { value: 2 });
    Object.defineProperty(types, 1, {
      get() {
        throw new Error('E224 regression: hasFiles 命中后仍继续遍历');
      },
    });
    expect(hasFiles({ types } as unknown as DataTransfer)).toBe(true);
  });
});

// 模拟 DataTransfer 的 files(jsdom 不能直接造原生 DataTransfer)
function dt(files: ReadonlyArray<{ name: string }>): {
  files: ReadonlyArray<File>;
} {
  return { files: files as unknown as ReadonlyArray<File> };
}

describe('pickDroppedDirectory', () => {
  it('单个目录 drop → 返回路径', async () => {
    const data = dt([{ name: 'projA' }]);
    const r = await pickDroppedDirectory(data, () => '/abs/projA', async () => true);
    expect(r).toBe('/abs/projA');
  });

  it('单个文件 drop(isDir=false)→ null', async () => {
    const data = dt([{ name: 'a.md' }]);
    const r = await pickDroppedDirectory(data, () => '/abs/a.md', async () => false);
    expect(r).toBeNull();
  });

  it('混合(文件 + 目录)→ 取第一个目录', async () => {
    const data = dt([{ name: 'a.md' }, { name: 'projB' }, { name: 'projC' }]);
    const paths = ['/abs/a.md', '/abs/projB', '/abs/projC'];
    const getPath = (f: { name: string }) =>
      paths[data.files.indexOf(f as unknown as File)] ?? '';
    const isDir = async (p: string) => p !== '/abs/a.md';
    const r = await pickDroppedDirectory(data, getPath, isDir);
    expect(r).toBe('/abs/projB');
  });

  it('多个目录 → 取第一个', async () => {
    const data = dt([{ name: 'projA' }, { name: 'projB' }]);
    const paths = ['/abs/projA', '/abs/projB'];
    const getPath = (f: { name: string }) =>
      paths[data.files.indexOf(f as unknown as File)] ?? '';
    const r = await pickDroppedDirectory(data, getPath, async () => true);
    expect(r).toBe('/abs/projA');
  });

  it('空 dataTransfer.files → null', async () => {
    const data = dt([]);
    const r = await pickDroppedDirectory(data, () => '', async () => true);
    expect(r).toBeNull();
  });

  it('getPath 返空 → 跳过该 entry', async () => {
    const data = dt([{ name: 'noPath' }, { name: 'projB' }]);
    const paths = ['', '/abs/projB'];
    const getPath = (f: { name: string }) =>
      paths[data.files.indexOf(f as unknown as File)] ?? '';
    const r = await pickDroppedDirectory(data, getPath, async () => true);
    expect(r).toBe('/abs/projB');
  });

  it('isDir 抛错 → 视为非目录,继续后续 entry', async () => {
    const data = dt([{ name: 'broken' }, { name: 'projB' }]);
    const paths = ['/abs/broken', '/abs/projB'];
    const getPath = (f: { name: string }) =>
      paths[data.files.indexOf(f as unknown as File)] ?? '';
    const isDir = async (p: string) => {
      if (p === '/abs/broken') throw new Error('EACCES');
      return true;
    };
    const r = await pickDroppedDirectory(data, getPath, isDir);
    expect(r).toBe('/abs/projB');
  });

  // 边界(E114):探测次数上限 + 超长路径不发 IPC(对齐 Terminal/Explorer drop 数量上限)。
  it('E114 超过 MAX_DROP_FILES 后的目录不被探测 → null,IPC 次数 ≤ 上限', async () => {
    // 造 MAX_DROP_FILES+1 个文件,只有最后一个(超出 cap)是目录 → 不应被探测到。
    const files = Array.from({ length: MAX_DROP_FILES + 1 }, (_, i) => ({
      name: `f${i}`,
    }));
    const data = dt(files);
    let isDirCalls = 0;
    const getPath = (f: { name: string }) => `/abs/${f.name}`;
    const isDir = async (p: string) => {
      isDirCalls++;
      return p === `/abs/f${MAX_DROP_FILES}`; // 仅最后一个(index=MAX_DROP_FILES)是目录
    };
    const r = await pickDroppedDirectory(data, getPath, isDir);
    expect(r).toBeNull(); // 目录在 cap 之外,未被探测
    expect(isDirCalls).toBeLessThanOrEqual(MAX_DROP_FILES);
  });

  it('E114 超长路径(> 4096)→ 不发起 isDir IPC,跳过', async () => {
    const data = dt([{ name: 'huge' }, { name: 'projB' }]);
    const longPath = '/abs/' + 'x'.repeat(5000);
    const paths = [longPath, '/abs/projB'];
    let probedLong = false;
    const getPath = (f: { name: string }) =>
      paths[data.files.indexOf(f as unknown as File)] ?? '';
    const isDir = async (p: string) => {
      if (p === longPath) probedLong = true;
      return true;
    };
    const r = await pickDroppedDirectory(data, getPath, isDir);
    expect(probedLong).toBe(false); // 超长路径未发起 IPC
    expect(r).toBe('/abs/projB'); // 跳过超长后命中下一个目录
  });
});

// 边界(E118):captureBoundedFiles —— 同步有界捕获 FileList,不全量物化超大列表。
describe('captureBoundedFiles (E118)', () => {
  it('少于 max → 全部捕获', () => {
    const files = [{ name: 'a' }, { name: 'b' }] as unknown as ArrayLike<File>;
    const r = captureBoundedFiles(files, 1000);
    expect(r).toHaveLength(2);
  });

  it('超过 max → 截断,且只读 max 个 index(不遍历全部)', () => {
    const N = 5000;
    const real = Array.from({ length: N }, (_, i) => ({
      name: `f${i}`,
    })) as unknown as File[];
    let reads = 0;
    const proxy = new Proxy(real, {
      get(t, prop, recv) {
        if (typeof prop === 'string' && /^[0-9]+$/.test(prop)) reads++;
        return Reflect.get(t, prop, recv);
      },
    }) as unknown as ArrayLike<File>;
    const r = captureBoundedFiles(proxy, MAX_DROP_FILES);
    expect(r).toHaveLength(MAX_DROP_FILES);
    expect(reads).toBeLessThanOrEqual(MAX_DROP_FILES);
    expect(reads).toBeLessThan(N);
    expect(captureBoundedFiles.toString()).not.toContain('.push(');
  });
});

// 边界(E176,E114/E118 同族 captureBoundedFiles 兄弟):hasDirectoryInFirstItems —— 按索引有界检查
// 前 max 个 DataTransferItem 是否含目录,不全量 Array.from 物化超大 DataTransferItemList。
describe('hasDirectoryInFirstItems (E176)', () => {
  const fileItem = () => ({ webkitGetAsEntry: () => ({ isDirectory: false }) });
  const dirItem = () => ({ webkitGetAsEntry: () => ({ isDirectory: true }) });

  it('null/undefined items → false', () => {
    expect(hasDirectoryInFirstItems(null, MAX_DROP_FILES)).toBe(false);
    expect(hasDirectoryInFirstItems(undefined, MAX_DROP_FILES)).toBe(false);
  });

  it('含目录(前 max 内)→ true;全文件 → false', () => {
    expect(
      hasDirectoryInFirstItems([fileItem(), dirItem(), fileItem()], MAX_DROP_FILES),
    ).toBe(true);
    expect(
      hasDirectoryInFirstItems([fileItem(), fileItem()], MAX_DROP_FILES),
    ).toBe(false);
  });

  it('webkitGetAsEntry 缺失/返 null → 视为非目录(不抛)', () => {
    expect(hasDirectoryInFirstItems([{}, { webkitGetAsEntry: () => null }], 10)).toBe(
      false,
    );
  });

  it('命中目录即短路(不继续读后续 index)', () => {
    const real = [dirItem(), ...Array.from({ length: 100 }, fileItem)];
    let reads = 0;
    const proxy = new Proxy(real, {
      get(t, prop, recv) {
        if (typeof prop === 'string' && /^[0-9]+$/.test(prop)) reads++;
        return Reflect.get(t, prop, recv);
      },
    }) as unknown as ArrayLike<unknown>;
    expect(hasDirectoryInFirstItems(proxy, MAX_DROP_FILES)).toBe(true);
    expect(reads).toBe(1); // 命中即停,只读 index 0
  });

  it('超大 items 且无目录 → 只读 max 个 index(不全量物化)', () => {
    const N = 5000;
    const real = Array.from({ length: N }, fileItem);
    let reads = 0;
    const proxy = new Proxy(real, {
      get(t, prop, recv) {
        if (typeof prop === 'string' && /^[0-9]+$/.test(prop)) reads++;
        return Reflect.get(t, prop, recv);
      },
    }) as unknown as ArrayLike<unknown>;
    expect(hasDirectoryInFirstItems(proxy, MAX_DROP_FILES)).toBe(false);
    expect(reads).toBeLessThanOrEqual(MAX_DROP_FILES);
    expect(reads).toBeLessThan(N);
  });
});

// a11y(A149):resolveDroppedWorkspace —— 区分 open / error(拖目录但 listDir 失败)/ ignore(只拖文件)。
describe('resolveDroppedWorkspace (A149)', () => {
  const ok = () => ({ ok: true as const });
  it('目录可 listDir → kind=open', async () => {
    const data = dt([{ name: 'projA' }]);
    const r = await resolveDroppedWorkspace(data, true, () => '/abs/projA', async () => ok());
    expect(r).toEqual({ kind: 'open', path: '/abs/projA' });
  });

  it('拖了目录但 listDir {ok:false} → kind=error(带 code)', async () => {
    const data = dt([{ name: 'gone' }]);
    const r = await resolveDroppedWorkspace(
      data,
      true,
      () => '/abs/gone',
      async () => ({ ok: false, code: 'FS_NOT_FOUND', message: 'gone' }),
    );
    expect(r).toEqual({ kind: 'error', code: 'FS_NOT_FOUND', message: 'gone' });
  });

  it('拖了目录但 listDir reject → kind=error(EXCEPTION 兜底)', async () => {
    const data = dt([{ name: 'boom' }]);
    const r = await resolveDroppedWorkspace(
      data,
      true,
      () => '/abs/boom',
      async () => {
        throw Object.assign(new Error('ipc down'), { code: 'EIO' });
      },
    );
    expect(r).toEqual({ kind: 'error', code: 'EIO', message: 'ipc down' });
  });

  it('只拖文件(hadDirectory=false)→ kind=ignore(静默,不报)', async () => {
    const data = dt([{ name: 'a.md' }]);
    const r = await resolveDroppedWorkspace(
      data,
      false,
      () => '/abs/a.md',
      async () => ({ ok: false, code: 'ENOTDIR', message: 'not dir' }),
    );
    expect(r).toEqual({ kind: 'ignore' });
  });
});
