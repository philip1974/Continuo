// BDD:暗色终端最低对比度保护(契约 5)。见同目录 README。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { terminalMinimumContrastRatio } from '../../panels/Terminal/useTerminal';

describe('终端 minimumContrastRatio', () => {
  it('暗色 4.5(VSCode terminal.integrated.minimumContrastRatio 默认),亮色 7(issue #24 刻意更严)', () => {
    expect(terminalMinimumContrastRatio('dark')).toBe(4.5);
    expect(terminalMinimumContrastRatio('light')).toBe(7);
  });

  it('构造终端与主题切换同用这一取值(不另写字面量)', () => {
    const src = readFileSync('src/panels/Terminal/useTerminal.ts', 'utf8');
    expect(src).toContain('minimumContrastRatio: terminalMinimumContrastRatio(initOptions.resolved)');
    expect(src).toContain('term.options.minimumContrastRatio = terminalMinimumContrastRatio(resolved)');
    expect(src.match(/minimumContrastRatio\s*[:=]\s*[\d(]|minimumContrastRatio\s*[:=][^\n]*\?/g)).toBeNull();
  });
});
