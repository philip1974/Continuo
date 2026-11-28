// BDD: search-ignore-files —— 在文件中查找与 Quick Open 遵从 .gitignore / .ignore(VSCode search.useIgnoreFiles,默认开)
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanDir } from '../../../electron/main/ipc/fs/list-dir';
import { runTextSearch } from '../../../electron/main/search/text-search';
import { walkWorkspaceFiles } from '../../plugins/quick-open/walk-files';
import { LIST_DIR_MAX_DEPTH, WORKSPACE_SCAN_EXCLUDE } from '../../../electron/shared/fs-limits';
import type { SearchFileResult, SearchQuery } from '../../../electron/shared/workspace-search';
import { SEARCH_USE_IGNORE_FILES } from '../../plugins/settings/core-setting-specs';
import { listDirInputSchema } from '../../../electron/main/ipc/fs.ipc';
import { searchStartInputSchema } from '../../../electron/main/services/text-search.service';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'search-ignore-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content = 'needle'): void {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

async function scanned(useIgnoreFiles = true, base = root): Promise<string[]> {
  const { entries } = await scanDir(base, {
    maxDepth: LIST_DIR_MAX_DEPTH,
    exclude: WORKSPACE_SCAN_EXCLUDE,
    withStats: false,
    useIgnoreFiles,
  });
  return entries
    .filter((e) => !e.isDirectory)
    .map((e) => path.relative(base, e.path).split(path.sep).join('/'))
    .sort();
}

const query = (o: Partial<SearchQuery> = {}): SearchQuery => ({
  pattern: 'needle',
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  include: '',
  exclude: '',
  ...o,
});

async function searched(q: SearchQuery): Promise<string[]> {
  const out: SearchFileResult[] = [];
  await runTextSearch({ root, query: q, onFiles: (f) => out.push(...f) });
  return out.map((f) => f.relPath).sort();
}

describe('gitignore 语法', () => {
  it('通配 / 目录 / 锚定 / ** / 否定', async () => {
    write('.gitignore', ['*.log', '!keep.log', 'tmp/', '/root-only.txt', 'docs/**/draft.md', ''].join('\n'));
    write('a.ts');
    write('x.log');
    write('keep.log');
    write('sub/y.log');
    write('tmp/t.ts');
    write('sub/tmp/t.ts');
    write('tmp.ts'); // tmp/ 只匹配目录
    write('root-only.txt');
    write('sub/root-only.txt'); // 锚定:只匹配根下
    write('docs/a/b/draft.md');
    write('docs/final.md');
    expect(await scanned()).toEqual([
      '.gitignore',
      'a.ts',
      'docs/final.md',
      'keep.log',
      'sub/root-only.txt',
      'tmp.ts',
    ]);
  });

  it('嵌套 .gitignore 作用于其下,可用 ! 取消上层的忽略;同层 .ignore 优先于 .gitignore', async () => {
    write('.gitignore', '*.gen.ts\n');
    write('pkg/.gitignore', '!*.gen.ts\nlocal.ts\n');
    write('pkg/.ignore', '!local.ts\nsecret.ts\n');
    write('a.gen.ts');
    write('pkg/b.gen.ts');
    write('pkg/local.ts');
    write('pkg/secret.ts');
    write('other/local.ts'); // pkg/.gitignore 不作用于兄弟目录
    expect(await scanned()).toEqual([
      '.gitignore',
      'other/local.ts',
      'pkg/.gitignore',
      'pkg/.ignore',
      'pkg/b.gen.ts',
      'pkg/local.ts',
    ]);
  });

  it('被忽略的目录不下钻,其下的 ! 不能重新包含(git 同)', async () => {
    write('.gitignore', 'gen/\n');
    write('gen/.gitignore', '!*\n');
    write('gen/a.ts');
    expect(await scanned()).toEqual(['.gitignore']);
  });

  it('不要求是 git 仓库;不读工作区根之上的忽略文件', async () => {
    write('.gitignore', 'ws/ignored-by-parent.ts\n');
    write('ws/ignored-by-parent.ts');
    write('ws/a.ts');
    expect(await scanned(true, path.join(root, 'ws'))).toEqual(['a.ts', 'ignored-by-parent.ts']);
  });

  it('超宽目录(条目数超过探测缓存)里的忽略文件同样生效', async () => {
    write('wide/.gitignore', '*.log\n');
    for (let i = 0; i < 1100; i++) write(`wide/f${i}.ts`, '');
    write('wide/x.log');
    const files = await scanned();
    expect(files).toHaveLength(1 + 1100);
    expect(files).not.toContain('wide/x.log');
  });

  it('忽略文件过大(> 1 MiB)或是目录 → 视作没有规则', async () => {
    write('.gitignore', `a.ts\n${'#'.repeat(1024 * 1024)}\n`);
    mkdirSync(path.join(root, '.ignore'));
    write('a.ts');
    expect(await scanned()).toEqual(['.gitignore', 'a.ts']);
  });

  it('关闭 → 忽略文件里的文件照常列出(资源管理器逐层列目录缺省也不读)', async () => {
    write('.gitignore', '*.log\n');
    write('x.log');
    expect(await scanned(false)).toEqual(['.gitignore', 'x.log']);
    const shallow = await scanDir(root, { useIgnoreFiles: true });
    expect(shallow.entries.map((e) => e.name).sort()).toEqual(['.gitignore', 'x.log']);
  });
});

describe('在文件中查找', () => {
  beforeEach(() => {
    write('.gitignore', 'logs/\n*.local\n');
    write('src/a.ts');
    write('logs/today.txt');
    write('config.local');
    write('dist/bundle.js');
    write('node_modules/pkg/index.js');
  });

  it('默认遵从忽略文件', async () => {
    expect(await searched(query())).toEqual(['src/a.ts']);
  });

  it('disregardIgnoreFiles(设置 search.useIgnoreFiles 关)→ 忽略文件里的照常搜,排除表照旧', async () => {
    expect(await searched(query({ disregardIgnoreFiles: true }))).toEqual(['config.local', 'logs/today.txt', 'src/a.ts']);
  });

  it('「使用排除设置与忽略文件」关 → 构建产物目录也搜,node_modules 等仍排除', async () => {
    expect(await searched(query({ disregardIgnoreFiles: true, disregardExcludeSettings: true }))).toEqual([
      'config.local',
      'dist/bundle.js',
      'logs/today.txt',
      'src/a.ts',
    ]);
  });

  it('search:start 入参接受两个开关(strict schema)', () => {
    const r = searchStartInputSchema.safeParse({
      searchId: 's1',
      root: '/w',
      query: query({ disregardIgnoreFiles: true, disregardExcludeSettings: true }),
    });
    expect(r.success).toBe(true);
  });
});

describe('Quick Open', () => {
  it('按 useIgnoreFiles 扫描(fs:scan-files 入参接受该选项)', async () => {
    write('.gitignore', 'out.txt\n');
    write('a.ts');
    write('out.txt');
    const listDir = async (p: string, opts?: Parameters<typeof scanDir>[1]) => ({ ok: true as const, data: await scanDir(p, opts) });
    const on = await walkWorkspaceFiles({ rootPath: root, listDir, useIgnoreFiles: true });
    const off = await walkWorkspaceFiles({ rootPath: root, listDir });
    expect(on.ok && on.data.map((f) => f.relPath).sort()).toEqual(['.gitignore', 'a.ts']);
    expect(off.ok && off.data.map((f) => f.relPath).sort()).toEqual(['.gitignore', 'a.ts', 'out.txt']);
    expect(listDirInputSchema.safeParse({ path: root, options: { maxDepth: 2, useIgnoreFiles: true } }).success).toBe(true);
  });

  it('设置 search.useIgnoreFiles:默认开', () => {
    expect(SEARCH_USE_IGNORE_FILES.id).toBe('search.useIgnoreFiles');
    expect(SEARCH_USE_IGNORE_FILES.default).toBe(true);
  });
});
