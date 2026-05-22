import { execFileSync, execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('migration step2 buffer merge · no dangling imports', () => {
  it('T7 has no dangling terminal-buffer.service imports (multi-line aware)', () => {
    const script = String.raw`
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
patterns = [
    re.compile(r"from\s+['\"][^'\"]*terminal-buffer\.service['\"]"),
    re.compile(r"import\s+\*\s+as\s+terminalBuffer"),
    re.compile(r"vi\.mock\s*\(\s*['\"][^'\"]*terminal-buffer\.service", re.DOTALL),
]
hits = []
for p in list((root / 'electron').rglob('*.ts')) + list((root / 'src').rglob('*.ts')):
    s = str(p)
    if 'migration-step2-buffer-merge' in s or 'node_modules' in s or '.git' in s:
        continue
    text = p.read_text()
    for rx in patterns:
        if rx.search(text):
            hits.append(str(p.relative_to(root)))
            break
print('\n'.join(sorted(set(hits))) if hits else 'CLEAN')
`;
    const out = execFileSync('python3', ['-c', script, process.cwd()], {
      encoding: 'utf8',
    }).trim();
    expect(out).toBe('CLEAN');
  });

  it('T7b has no dangling BUFFER_SESSION_NOT_FOUND references', () => {
    const out = execSync(
      'grep -rn "BUFFER_SESSION_NOT_FOUND" --include="*.ts" --include="*.md" electron src 2>/dev/null | grep -v "migration-step2-buffer-merge" || true',
      { encoding: 'utf8' },
    ).trim();
    expect(out).toBe('');
  });
});
