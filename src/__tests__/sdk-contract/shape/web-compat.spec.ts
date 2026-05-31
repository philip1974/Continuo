import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// SOURCE: ~/Desktop/continuo-sample-plugin/scripts/check-web-compat.mjs
const PATTERNS: readonly { source: string; regex: RegExp }[] = [
  { source: "from ['\"]node:", regex: /from ['"]node:/ },
  { source: 'Buffer\\.', regex: /Buffer\./ },
  { source: 'NodeJS\\.', regex: /NodeJS\./ },
  {
    source: 'process\\.(env|cwd|platform)',
    regex: /process\.(env|cwd|platform)/,
  },
  { source: '__dirname', regex: /__dirname/ },
  { source: '__filename', regex: /__filename/ },
  {
    source: "\\.toString\\(['\"]utf-?8['\"]\\)",
    regex: /\.toString\(['"]utf-?8['"]\)/,
  },
  { source: 'global(?:This)?\\.', regex: /global(?:This)?\./ },
];

interface WebCompatHit {
  path: string;
  line: number;
  pattern: string;
}

interface WebCompatAllowlistEntry extends WebCompatHit {
  reason: string;
}

function posixPath(path: string): string {
  return path.split(sep).join('/');
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!full.endsWith('.ts') && !full.endsWith('.tsx')) continue;
    if (full.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

function hitKey(hit: WebCompatHit): string {
  return `${hit.path}:${hit.line}:${hit.pattern}`;
}

function collectHits(): WebCompatHit[] {
  const root = process.cwd();
  const files = listSourceFiles(join(root, 'src/plugins'));
  const hits: WebCompatHit[] = [];

  for (const file of files) {
    const rel = posixPath(relative(root, file));
    const lines = readFileSync(file, 'utf-8').split(/\r?\n/);
    lines.forEach((lineText, index) => {
      for (const pattern of PATTERNS) {
        if (pattern.regex.test(lineText)) {
          hits.push({
            path: rel,
            line: index + 1,
            pattern: pattern.source,
          });
        }
      }
    });
  }

  return hits.sort((a, b) => hitKey(a).localeCompare(hitKey(b)));
}

function readAllowlist(): WebCompatAllowlistEntry[] {
  const url = new URL('./web-compat-allowlist.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf-8')) as WebCompatAllowlistEntry[];
}

describe('sdk-contract shape: plugin SDK web compatibility audit', () => {
  it('T5 keeps src/plugins web-compat hits fully audited', () => {
    const hits = collectHits();
    const allowlist = readAllowlist();
    const hitKeys = new Set(hits.map(hitKey));
    const allowlistKeys = new Set(allowlist.map(hitKey));

    const unexpected = hits.filter((hit) => !allowlistKeys.has(hitKey(hit)));
    const stale = allowlist.filter((entry) => !hitKeys.has(hitKey(entry)));

    if (allowlist.length > 0) {
      console.info(
        '[sdk-contract:web-compat] allowlisted hits',
        allowlist.map((entry) => ({
          path: entry.path,
          line: entry.line,
          pattern: entry.pattern,
          reason: entry.reason,
        })),
      );
    }

    expect(unexpected).toEqual([]);
    expect(stale).toEqual([]);
    expect(hits.length).toBe(allowlist.length);
  });
});
