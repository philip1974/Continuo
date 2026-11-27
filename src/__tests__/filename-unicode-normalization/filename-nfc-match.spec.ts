// BDD: filename-unicode-normalization — 磁盘上 NFD 编码的文件名(如 `회의록-NFD.md`)与键入的 NFC 查询照样匹配。
// 见同目录 README.md。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { walkWorkspaceFiles } from '../../plugins/quick-open/walk-files';
import { fuzzyFilter } from '../../plugins/command-palette/fuzzy';
import { orderByRecent } from '../../plugins/quick-open/recent-files';
import { openRecentItems } from '../../plugins/open-recent/OpenRecentModal';
import { normalizeSearchQuery } from '../../lib/search-query';
import { findTypeAheadIndex } from '../../panels/Explorer/tree-keyboard';
import { searchOpenEditors, searchRelPath } from '../../panels/Search/open-editor-search';
import { listDir, scanDir } from '../../../electron/main/ipc/fs/list-dir';
import { runTextSearch } from '../../../electron/main/search/text-search';
import {
  buildSearchRegExp,
  compileSearchPathFilter,
  type SearchFileResult,
  type SearchQuery,
} from '../../../electron/shared/workspace-search';

const NFC_STEM = '회의록';
const NFD_STEM = NFC_STEM.normalize('NFD');
const NFD_NAME = `${NFD_STEM}-NFD.md`;

it('前提:NFD 与 NFC 码元不同', () => {
  expect(NFD_STEM).not.toBe(NFC_STEM);
  expect(NFD_STEM.length).toBeGreaterThan(NFC_STEM.length);
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'nfc-'));
  writeFileSync(path.join(root, NFD_NAME), '안건 TODO\n');
  writeFileSync(path.join(root, 'other.md'), 'TODO\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ipcListDir = async (p: string, o?: Parameters<typeof listDir>[1]) => ({ ok: true as const, data: await scanDir(p, o) });

describe('Quick Open(⌘P)', () => {
  it('NFD 文件名:键入 NFC 查询能搜到;显示 NFC,打开用磁盘原样路径', async () => {
    // 磁盘上确实是 NFD(APFS / ext4 都按原样保存)
    expect(readdirSync(root)).toContain(NFD_NAME);
    const r = await walkWorkspaceFiles({ rootPath: root, listDir: ipcListDir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hits = fuzzyFilter(r.data, normalizeSearchQuery(NFC_STEM), (f) => f.relPathLower);
    expect(hits.map((f) => f.name)).toEqual([`${NFC_STEM}-NFD.md`]);
    expect(hits[0]!.relPath).toBe(`${NFC_STEM}-NFD.md`);
    expect(hits[0]!.absPath).toBe(path.join(root, NFD_NAME));
  });

  it('粘贴的 NFD 查询也归一成 NFC', () => {
    expect(normalizeSearchQuery(` ${NFD_STEM} `)).toBe(NFC_STEM);
  });

  it('最近项:tab 记下的是 NFC 路径、扫描到的是 NFD 路径,仍算同一个最近文件', () => {
    const files = [
      { absPath: '/w/other.md' },
      { absPath: `/w/${NFD_NAME}` },
    ];
    const { items, recentCount } = orderByRecent(files, [`/w/${NFD_NAME}`.normalize('NFC')]);
    expect(recentCount).toBe(1);
    expect(items[0]).toBe(files[1]);
  });
});

describe('打开最近的文件夹', () => {
  it('NFD 文件夹名:NFC 查询能搜到', () => {
    const items = openRecentItems([`/Users/me/${NFD_STEM}`], null);
    const hits = fuzzyFilter(items, normalizeSearchQuery(NFC_STEM), (i) => i.lower);
    expect(hits).toHaveLength(1);
  });
});

describe('资源管理器键入跳转', () => {
  it('NFD 名字:键入 NFC 前缀能跳到', () => {
    const names = ['a.md', 'café.md'.normalize('NFD'), 'z.md'];
    expect(findTypeAheadIndex(names, 0, 'café')).toBe(1);
  });
});

describe('在文件中查找(⇧⌘F)', () => {
  const q = (include = '', exclude = ''): SearchQuery => ({
    pattern: 'TODO',
    isRegex: false,
    matchCase: false,
    wholeWord: false,
    include,
    exclude,
  });

  it('「包含的文件」写 NFC 韩文名能命中 NFD 文件;结果 relPath 为 NFC,path 为磁盘原样', async () => {
    const found: SearchFileResult[] = [];
    await runTextSearch({ root, query: q(`${NFC_STEM}*`), onFiles: (fs) => found.push(...fs) });
    expect(found.map((f) => f.relPath)).toEqual([`${NFC_STEM}-NFD.md`]);
    expect(found[0]!.path).toBe(path.join(root, NFD_NAME));
  });

  it('「排除的文件」写 NFC 韩文名能排除 NFD 文件', async () => {
    const found: SearchFileResult[] = [];
    await runTextSearch({ root, query: q('', `${NFC_STEM}*`), onFiles: (fs) => found.push(...fs) });
    expect(found.map((f) => f.relPath)).toEqual(['other.md']);
  });

  it('glob 过滤器两侧都归一:NFD 模式也能命中 NFC 路径', () => {
    const filter = compileSearchPathFilter(`${NFD_STEM}*`, '')!;
    expect(filter(`${NFC_STEM}-NFD.md`)).toBe(true);
    expect(filter(NFD_NAME)).toBe(true);
  });

  it('已打开编辑器的内存结果与磁盘结果用同一 NFC relPath 作覆盖键', () => {
    expect(searchRelPath('/w', `/w/${NFD_NAME}`)).toBe(`${NFC_STEM}-NFD.md`);
    const query = q();
    const r = searchOpenEditors([{ filePath: `/w/${NFD_NAME}`, content: 'TODO' }], '/w', query, buildSearchRegExp(query));
    expect(r.files[0]!.relPath).toBe(`${NFC_STEM}-NFD.md`);
    expect(r.files[0]!.path).toBe(`/w/${NFD_NAME}`);
  });
});
