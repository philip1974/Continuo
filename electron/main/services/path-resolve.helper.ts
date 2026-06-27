import { promises as fs, type Stats } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, sep } from 'node:path';
import { ScopeError } from '../../../src/plugins/types';
import { leafNameRejectReason } from '../../shared/leaf-name';

export interface ResolveReadResult {
  canonical: string;
}

export interface ResolveWriteResult {
  parentCanonical: string;
  leaf: string;
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
  // 边界(E274):收口到共享 leafNameRejectReason(与 Explorer drop/create/rename 的 isValidLeafName 同一
  // 规则集,消漂移)。规则不变(POSIX + Windows 危险名);超限上限收紧到 FS_NAME_MAX=255(单组件名上限,
  // 严于原 260/4096,无安全回归)。
  const reason = leafNameRejectReason(leaf);
  if (reason !== null) {
    throw new ScopeError(`leaf rejected: ${reason}`, {
      target: fullTarget,
      reason,
    });
  }
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

async function resolveLeafPreserving(
  target: string,
  rejectSymlinkLeaf: boolean,
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

  if (rejectSymlinkLeaf) {
    const fullPath = `${parentCanonical}${sep}${leaf}`;
    let leafStat: Stats | null = null;
    try {
      leafStat = await fs.lstat(fullPath);
    } catch (err) {
      // 只有 ENOENT 才是「leaf 不存在,可写」。EACCES/EIO/ELOOP 等「无法确认 leaf 是否
      // symlink」不能 fail-open —— 否则绕过 symlink-leaf-rejected 安全契约,plugin 可经
      // 链接叶子写到 scope 外(codex P1,与 rename/move/atomicReplace fail-closed 守卫一致)。
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ScopeError(
          'cannot stat write leaf',
          { target: fullPath },
          { cause: err },
        );
      }
    }
    if (leafStat && leafStat.isSymbolicLink()) {
      throw new ScopeError('symlink leaf rejected', { target: fullPath });
    }
  }
  return { parentCanonical, leaf };
}

export function resolveForWrite(target: string): Promise<ResolveWriteResult> {
  return resolveLeafPreserving(target, true);
}

/**
 * 解析「不跟随 leaf 符号链接」的源路径(rm / lstat / rename-src 用)。
 * 与 resolveForWrite 一样 realpath 父目录 + 保留原 leaf(防 `..` 逃逸 + 防父目录
 * 符号链接逃逸),但**不拒绝** symlink leaf —— 这些操作要作用在「链接本身」而非其
 * 目标:rm 删链接、lstat 看链接、rename 移链接。若改用 resolveForRead(realpath 整
 * 条路径)会跟随到 target,导致删/改/stat 的是目标数据,违反「不跟随链接」语义
 * (SDK 暴露 lstat/isSymlink,listDir 也保留 symlink 标记 → API 本应区分链接 vs 目标)。
 * 安全性与 write 同级:父目录已 realpath、leaf 经 validateLeaf(拒 `..`/分隔符等),
 * fs.rm/lstat/rename 作用在 fullPath(链接)上不会跟随,故不构成 scope 逃逸。
 */
export function resolveNoFollowLeaf(target: string): Promise<ResolveWriteResult> {
  return resolveLeafPreserving(target, false);
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
