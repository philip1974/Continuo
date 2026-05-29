import { promises as fs, type Stats } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, sep } from 'node:path';
import { ScopeError } from '../../../src/plugins/types';

export interface ResolveReadResult {
  canonical: string;
}

export interface ResolveWriteResult {
  parentCanonical: string;
  leaf: string;
}

const MAX_PATH_POSIX = 4096;
const MAX_PATH_WIN = 260;
const CONTROL_CHARS = /[\x00-\x1f]/;
const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const NTFS_83_ALIAS = /~[0-9]/;

function expandHome(p: string): string {
  if (!p.startsWith('~')) return p;
  const home =
    platform() === 'win32' ? (process.env.USERPROFILE ?? '') : (homedir() ?? '');
  if (!home) {
    throw new ScopeError('cannot resolve home', {
      target: p,
      reason: 'no $HOME/$USERPROFILE',
    });
  }
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return home + p.slice(1);
  throw new ScopeError('cannot resolve ~user form', { target: p });
}

/**
 * Validate leaf segment (the basename of a target path).
 * Rejects POSIX + Windows filesystem hazards.
 * Returns void on success; throws ScopeError on rejection.
 */
function validateLeaf(leaf: string, fullTarget: string): void {
  const reject = (reason: string): never => {
    throw new ScopeError(`leaf rejected: ${reason}`, {
      target: fullTarget,
      reason,
    });
  };
  if (leaf === '') reject('empty leaf');
  if (leaf === '.' || leaf === '..') reject(`leaf is "${leaf}"`);
  if (leaf.includes('/') || leaf.includes('\\')) {
    reject('leaf contains path separator');
  }
  if (NTFS_83_ALIAS.test(leaf)) {
    reject('leaf matches NTFS 8.3 short-name pattern');
  }
  if (leaf.includes('~')) reject('leaf contains ~');
  if (leaf.includes('..')) reject('leaf contains ..');
  if (CONTROL_CHARS.test(leaf)) reject('leaf contains control char');
  if (leaf.length > MAX_PATH_WIN) {
    reject('leaf exceeds 260 chars (Windows MAX_PATH)');
  }
  if (leaf.length > MAX_PATH_POSIX) reject('leaf exceeds 4096 chars (POSIX)');
  if (leaf.startsWith('/') || leaf.startsWith('\\')) {
    reject('leaf starts with separator');
  }
  if (leaf.includes(':')) reject('leaf contains : (Windows ADS hazard)');
  if (WIN_RESERVED.test(leaf)) reject('leaf is Windows reserved device name');
  if (leaf.endsWith('.') || leaf.endsWith(' ')) {
    reject('leaf has trailing dot or space');
  }
  if (leaf.normalize('NFC') !== leaf) reject('leaf is not NFC-normalized');
}

// Test-only export, do not use in non-test code.
export { validateLeaf as _validateLeafForTest };

export async function resolveForRead(target: string): Promise<ResolveReadResult> {
  const expanded = expandHome(target);
  try {
    const canonical = await fs.realpath(expanded);
    return { canonical };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ScopeError('target does not exist', {
        target,
        reason: 'ENOENT',
      });
    }
    throw new ScopeError(
      `realpath failed: ${code ?? 'unknown'}`,
      { target },
      { cause: err },
    );
  }
}

export async function resolveForWrite(
  target: string,
): Promise<ResolveWriteResult> {
  const expanded = expandHome(target);
  if (!isAbsolute(expanded)) {
    throw new ScopeError('target must be absolute', { target });
  }
  const parent = dirname(expanded);
  const leaf = expanded.slice(parent.length + (parent.endsWith(sep) ? 0 : 1));
  validateLeaf(leaf, target);

  let parentCanonical: string;
  try {
    parentCanonical = await fs.realpath(parent);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ScopeError('parent missing', {
        target: parent,
        reason: 'ENOENT',
      });
    }
    throw new ScopeError(
      `parent realpath failed: ${code ?? 'unknown'}`,
      { target: parent },
      { cause: err },
    );
  }

  const fullPath = `${parentCanonical}${sep}${leaf}`;
  let leafStat: Stats | null = null;
  try {
    leafStat = await fs.lstat(fullPath);
  } catch {
    // doesn't exist - fine for write
  }
  if (leafStat && leafStat.isSymbolicLink()) {
    throw new ScopeError('symlink leaf rejected', { target: fullPath });
  }
  return { parentCanonical, leaf };
}

export const resolveForRenameDst = resolveForWrite;
