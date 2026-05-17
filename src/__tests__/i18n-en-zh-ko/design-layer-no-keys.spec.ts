// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const DESIGN_ROOT = path.join(ROOT, 'src/design');

function collectTsxFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsxFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.tsx')) {
      files.push(fullPath);
    }
  }
  return files;
}

const forbiddenPatterns: readonly RegExp[] = [
  /\buseT\s*\(/,
  /\bi18n\.t\s*\(/,
  /\btranslate\s*\(/,
  /from\s+['"]@\/i18n['"]/,
  /from\s+['"]@\/stores\/settings\.store['"]/,
];

describe('design 共享层无 i18n 渗透（CLAUDE.md 铁律）', () => {
  it('src/design/**/*.tsx 不含 i18n 调用或 settings store import', () => {
    const hits: string[] = [];
    for (const file of collectTsxFiles(DESIGN_ROOT)) {
      const body = readFileSync(file, 'utf-8');
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(body)) {
          hits.push(path.relative(ROOT, file));
          break;
        }
      }
    }

    expect(hits).toEqual([]);
  });
});
