import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const TARGET_DIR = join(ROOT, 'src/__tests__/sdk-contract');

const PATTERNS = [
  { label: '\\bit\\.skip\\(', regex: /\bit\.skip\(/ },
  { label: '\\bdescribe\\.skip\\(', regex: /\bdescribe\.skip\(/ },
  { label: '\\.todo\\(', regex: /\.todo\(/ },
  { label: 'xit\\(', regex: /\bxit\(/ },
  { label: 'xdescribe\\(', regex: /\bxdescribe\(/ },
];

function posixPath(path) {
  return path.split(sep).join('/');
}

function listSpecFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSpecFiles(full));
      continue;
    }
    if (full.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const hits = [];

for (const file of listSpecFiles(TARGET_DIR)) {
  const rel = posixPath(relative(ROOT, file));
  const lines = readFileSync(file, 'utf-8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(line)) {
        hits.push({
          path: rel,
          line: index + 1,
          pattern: pattern.label,
        });
      }
    }
  });
}

if (hits.length > 0) {
  console.error('sdk-contract: skip/todo hits found');
  for (const hit of hits) {
    console.error(`${hit.path}:${hit.line} ${hit.pattern}`);
  }
  process.exit(1);
}

console.log('sdk-contract: 0 skip/todo hits');
