// 第三方 GitHub Action 固定到 commit SHA(标签可被重新指向),workflow 默认 GITHUB_TOKEN 只读,
// 并由 Dependabot 每周提 PR 升级。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WF_DIR = join(process.cwd(), '.github', 'workflows');
const workflows = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));

describe('GitHub Actions 供应链加固', () => {
  it.each(workflows)('%s:每个 uses 都固定到 40 位 commit SHA 并注释版本', (wf) => {
    const text = readFileSync(join(WF_DIR, wf), 'utf8');
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(.+)$/gm)].map((m) => (m[1] ?? '').trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    }
  });

  it.each(workflows)('%s:顶层声明 permissions: contents: read', (wf) => {
    const text = readFileSync(join(WF_DIR, wf), 'utf8');
    expect(text).toMatch(/^permissions:\n {2}contents: read\n/m);
  });

  it('Dependabot 每周检查 github-actions 更新', () => {
    const p = join(process.cwd(), '.github', 'dependabot.yml');
    expect(existsSync(p)).toBe(true);
    const text = readFileSync(p, 'utf8');
    expect(text).toMatch(/package-ecosystem:\s*github-actions/);
    expect(text).toMatch(/interval:\s*weekly/);
  });
});
