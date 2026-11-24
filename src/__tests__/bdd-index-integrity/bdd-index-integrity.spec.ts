// @vitest-environment node
// BDD 索引与目录一致:含 spec(含子目录,如 sdk-contract/shape/)的每个主题都在 INDEX.md 里、每个 spec 都被列出。
// bdd-index 曾只扫主题第一层,sdk-contract 的 11 个 spec 整个主题从索引消失;新增 spec 后漏跑 `pnpm bdd:index` 同样被发现。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(process.cwd(), 'src/__tests__');

function specsUnder(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...specsUnder(full, rel));
    else if (/\.spec\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

describe('BDD INDEX.md 与目录一致', () => {
  const index = readFileSync(path.join(ROOT, 'INDEX.md'), 'utf8');
  const topics = readdirSync(ROOT).filter((n) => !n.startsWith('_') && statSync(path.join(ROOT, n)).isDirectory());

  it('每个含 spec 的主题的每个 spec 都被索引(含子目录)', () => {
    const missing: string[] = [];
    for (const topic of topics) {
      for (const spec of specsUnder(path.join(ROOT, topic))) {
        if (!index.includes(`(./${topic}/${spec})`)) missing.push(`${topic}/${spec}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
