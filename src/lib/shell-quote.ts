export type ShellFamily = 'posix' | 'cmd' | 'powershell';

export type QuoteResult =
  | { ok: true; quoted: string }
  | { ok: false; reason: 'control_char' | 'cmd_unrepresentable' };

const POSIX_BARE_SAFE = /^[A-Za-z0-9_\-./@%+=:,]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\x00-\x1f]/;

function quotePosix(path: string): string {
  if (POSIX_BARE_SAFE.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

function quotePowerShell(path: string): string {
  return `'${path.replace(/'/g, "''")}'`;
}

function quoteCmd(path: string): QuoteResult {
  if (path.includes('"') || path.includes('%')) {
    return { ok: false, reason: 'cmd_unrepresentable' };
  }
  return { ok: true, quoted: `"${path}"` };
}

export function quoteForShell(path: string, family: ShellFamily): QuoteResult {
  if (CONTROL_CHAR.test(path)) return { ok: false, reason: 'control_char' };

  if (family === 'posix') return { ok: true, quoted: quotePosix(path) };
  if (family === 'powershell') return { ok: true, quoted: quotePowerShell(path) };
  return quoteCmd(path);
}

export function quotePaths(
  paths: string[],
  family: ShellFamily,
): {
  quoted: string[];
  skipped: Array<{ path: string; reason: string }>;
} {
  const quoted: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const path of paths) {
    const r = quoteForShell(path, family);
    if (r.ok) {
      quoted.push(r.quoted);
    } else {
      skipped.push({ path, reason: r.reason });
    }
  }

  return { quoted, skipped };
}

export function joinWithTrailingSpace(quoted: string[]): string {
  if (quoted.length === 0) return '';
  return `${quoted.join(' ')} `;
}
