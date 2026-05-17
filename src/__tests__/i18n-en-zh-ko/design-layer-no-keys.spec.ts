import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

describe('design 共享层无 i18n 渗透（CLAUDE.md 铁律）', () => {
  it('src/design/**/*.tsx 不含 useT(/i18n.t(/translate( 调用', () => {
    const hits: string[] = [];
    for (const file of globSync('src/design/**/*.tsx', { cwd: ROOT })) {
      const body = readFileSync(path.join(ROOT, file), 'utf-8');
      if (/\b(?:useT|translate)\s*\(|\bi18n\.t\s*\(/.test(body)) {
        hits.push(file);
      }
    }

    expect(hits).toEqual([]);
    expect.fail('topic-16 i18n implementation not wired yet');
  });
});
