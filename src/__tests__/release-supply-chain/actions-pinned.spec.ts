// 第三方 GitHub Action 固定到 commit SHA(标签可被重新指向),workflow 默认 GITHUB_TOKEN 只读,
// 并由 Dependabot 每周提 PR 升级。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WF_DIR = join(process.cwd(), '.github', 'workflows');
const workflows = readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));
// 本仓 composite action(workflow 经 `uses: ./.github/actions/<name>` 引用):其中的第三方 action 同样须固定 SHA。
const ACTIONS_DIR = join(process.cwd(), '.github', 'actions');
const localActions = existsSync(ACTIONS_DIR)
  ? readdirSync(ACTIONS_DIR).map((d) => join('..', 'actions', d, 'action.yml'))
  : [];

describe('GitHub Actions 供应链加固', () => {
  it.each([...workflows, ...localActions])('%s:每个第三方 uses 都固定到 40 位 commit SHA 并注释版本', (wf) => {
    const text = readFileSync(join(WF_DIR, wf), 'utf8');
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(.+)$/gm)].map((m) => (m[1] ?? '').trim());
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      // 本仓 composite action(./.github/actions/*)随本仓 commit 固定,本身即受上一条约束覆盖。
      if (/^\.\/\.github\/actions\/[\w-]+$/.test(u)) {
        expect(existsSync(join(process.cwd(), u, 'action.yml'))).toBe(true);
        continue;
      }
      expect(u).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    }
  });

  it.each(workflows)('%s:顶层声明 permissions: contents: read', (wf) => {
    // Windows 检出可能是 CRLF(core.autocrlf):统一换行后再按行匹配。
    const text = readFileSync(join(WF_DIR, wf), 'utf8').replace(/\r\n/g, '\n');
    expect(text).toMatch(/^permissions:\n {2}contents: read\n/m);
  });

  it('Dependabot 每周检查 github-actions 更新', () => {
    const p = join(process.cwd(), '.github', 'dependabot.yml');
    expect(existsSync(p)).toBe(true);
    const text = readFileSync(p, 'utf8');
    expect(text).toMatch(/package-ecosystem:\s*github-actions/);
    // composite action 目录须列入,否则其中固定的 SHA 不会被升级。
    for (const a of localActions) {
      expect(text).toContain(`- /.github/actions/${a.split(/[\\/]/)[2]}`);
    }
    expect(text).toMatch(/interval:\s*weekly/);
  });
});
