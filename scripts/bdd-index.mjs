#!/usr/bin/env node
// 扫描 src/__tests__/<topic>/ 下的 BDD 主题,生成 INDEX.md。
// CLAUDE.md 约定:每个主题包含 README.md(行为描述) 与 *.spec.ts(可执行规范)。

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BDD_ROOT = path.join(ROOT, 'src/__tests__');
const INDEX_FILE = path.join(BDD_ROOT, 'INDEX.md');

async function firstHeading(file) {
  if (!existsSync(file)) return null;
  const raw = await readFile(file, 'utf-8');
  const m = raw.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

async function listSpecs(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && /\.spec\.tsx?$/.test(entry.name)) out.push(entry.name);
  }
  return out.sort();
}

async function main() {
  if (!existsSync(BDD_ROOT)) {
    console.error(`[bdd:index] ${BDD_ROOT} 不存在`);
    process.exit(1);
  }

  const topics = [];
  for (const entry of await readdir(BDD_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const topicDir = path.join(BDD_ROOT, entry.name);
    const specs = await listSpecs(topicDir);
    if (specs.length === 0) continue;
    const title = (await firstHeading(path.join(topicDir, 'README.md'))) ?? entry.name;
    topics.push({ slug: entry.name, title, specs });
  }
  topics.sort((a, b) => a.slug.localeCompare(b.slug));

  const lines = [
    '# BDD 规范索引',
    '',
    '> 由 `pnpm bdd:index` 自动生成,请勿手工编辑。',
    '',
  ];
  if (topics.length === 0) {
    lines.push('_暂无 BDD 主题。新增 `src/__tests__/<topic>/` 后重跑 `pnpm bdd:index`。_');
  } else {
    for (const t of topics) {
      lines.push(`## [${t.title}](./${t.slug}/README.md)`);
      lines.push('');
      for (const spec of t.specs) {
        lines.push(`- [\`${spec}\`](./${t.slug}/${spec})`);
      }
      lines.push('');
    }
  }

  await writeFile(INDEX_FILE, lines.join('\n'));
  console.log(`[bdd:index] 写入 ${path.relative(ROOT, INDEX_FILE)},共 ${topics.length} 个主题`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
