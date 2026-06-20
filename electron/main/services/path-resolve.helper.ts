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
const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const NTFS_83_ALIAS = /~[0-9]/;

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0 && c <= 0x1f) return true;
  }
  return false;
}

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
  if (hasControlChar(leaf)) reject('leaf contains control char');
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

function stripTrailingSep(p: string): string {
  let end = p.length;
  while (end > 1 && (p[end - 1] === '/' || p[end - 1] === '\\')) end--;
  return p.slice(0, end);
}

/**
 * 把「授予的 scope 目录路径」归一化到与 PathScopeRegistry.check 的 probe **同一空间**。
 * check 对 fs 操作的 target 走 expandHome + realpath(见 resolveForRead/Write),probe 因此
 * 是去符号链接的绝对 canonical 路径;而 grant 此前裸存原始 `s.path`。两者不在同一空间 →
 *   - `~/proj`(types.ts 文档承诺 host-side 展开)永不匹配 → 该 scope 静默死掉;
 *   - macOS `/tmp/x`(/tmp 是 /private/tmp 的符号链接)等含符号链接组件的路径同样失配。
 * 二者都是 fail-closed(误拒非越权),但破坏了文档契约。这里对 scope 做同款 expandHome +
 * realpath,使授予侧与校验侧对称。
 *
 * 去尾分隔符,让 `s.path + sep` 前缀匹配成立(`/ws/dir/` → `/ws/dir`)。scope 目录尚不存在
 * (ENOENT 等)时回退到 home 展开后的路径(至少把 `~` 展开并记录;真去该目录下操作时其自身
 * realpath 仍会失败,语义不变)。
 */
export async function canonicalizeScopePath(rawPath: string): Promise<string> {
  let expanded: string;
  try {
    expanded = expandHome(rawPath);
  } catch {
    // expandHome 对 `~user` 形式 / 无 $HOME 会抛 ScopeError。退化为原始路径(死 scope:
    // 不匹配 canonical probe,但与改动前「裸存」行为一致),**不能**让单条畸形 scope
    // 抛出去 —— 调用方 request-scope handler 用 Promise.all 批量归一化,抛出会毒死整批
    // (含同请求里的合法 scope)并把 'grant' 决议变成 IPC 异常。
    return stripTrailingSep(rawPath);
  }
  try {
    return stripTrailingSep(await fs.realpath(expanded));
  } catch {
    return stripTrailingSep(expanded);
  }
}
