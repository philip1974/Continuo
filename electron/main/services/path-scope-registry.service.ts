import { EventEmitter } from 'node:events';
import { sep } from 'node:path';
import { IdentityRegistry } from './identity-registry.service';
import {
  resolveForRead,
  resolveForRenameDst,
  resolveForWrite,
  resolveNoFollowLeaf,
} from './path-resolve.helper';
import { ScopeError, type PathScope } from '../../../src/plugins/types';
import { FS_PATH_MAX } from '../../shared/fs-limits';

// 'lstat' / 'remove' / 'rename-src' 走「不跟随 leaf 符号链接」解析 —— 作用在链接本身。
export type ScopeOpType =
  | 'read'
  | 'write'
  | 'mkdir'
  | 'rename-dst'
  | 'lstat'
  | 'remove'
  | 'rename-src';
export type ScopeMode = 'r' | 'rw';

export interface CheckResultRead {
  canonical: string;
}

export interface CheckResultWrite {
  parentCanonical: string;
  leaf: string;
  /** Full computed path = parentCanonical + sep + leaf */
  fullPath: string;
}

export type CheckResult = CheckResultRead | CheckResultWrite;

export interface ScopeUpdatedEvent {
  pluginId: string;
  scopes: readonly PathScope[];
}

/**
 * probe 是否在 scope 子树内(同路径或子路径)。注意根目录:scopePath 本身已以分隔符
 * 结尾(POSIX `/`)时不能再拼一个 sep —— `'/' + sep` = `'//'`,任何子路径都不以 `'//'`
 * 开头 → 根 scope 误拒所有子路径(codex P2)。统一:scope 已以 sep 结尾则直接做前缀,
 * 否则补一个 sep(防 `/ws/dir` 误匹配 `/ws/dirother`)。
 */
function isWithinScope(scopePath: string, probe: string): boolean {
  if (probe === scopePath) return true;
  const prefix = scopePath.endsWith(sep) ? scopePath : scopePath + sep;
  return probe.startsWith(prefix);
}

// 边界(E79 注册表数量上限族 / E81):单次 request-scope 已限 64 条(E31),但插件可多次请求不同
// 路径,经 mergeScopes 把 pluginScopes 与 _plugin-path-scopes.json 持续撑大;此后每次 check() 线性
// 扫描 scopes、covers() 是 requested×scopes、启动 hydrate/持久化都随授权数线性增长,畸形插件可放大
// 主进程 CPU/内存与元数据文件。grant/hydrate/mergeScopes 统一在唯一-path 合并处执行 per-plugin +
// 全局上限,超限 fail-closed(丢弃新增 path,不无界增长;已存在 path 放宽 mode 不增计数)。
const MAX_SCOPES_PER_PLUGIN = 256;
const MAX_SCOPES_GLOBAL = 4096;

export class PathScopeRegistry extends EventEmitter {
  private readonly pluginScopes = new Map<string, PathScope[]>();
  // 边界(E81):全局唯一-path scope 累计数(O(1) 维护,避免每次 merge 遍历全表求和)。
  private totalScopes = 0;
  /**
   * 已从磁盘水合过的 plugin。防止每次 requestScope 都打盘;revokeAll 时清除,
   * 以便插件重注册(re-enable / HMR)后重新水合。
   */
  private readonly hydrated = new Set<string>();

  constructor(private readonly identityRegistry: IdentityRegistry) {
    super();
  }

  /**
   * Main IPC handler first line. Throws PluginIdentityError (via identityRegistry)
   * or ScopeError. Returns canonical resolution for downstream fs op.
   *
   * @param token capability token from preload-bound wrapper
   * @param senderId event.sender.id (explicit per P1-1, not internal lookup)
   * @param opType which fs operation is gated
   * @param target raw target path from plugin
   * @param mode 'r' (read-only ok) or 'rw' (writable scope required)
   */
  async check(
    token: string,
    senderId: number,
    opType: ScopeOpType,
    target: string,
    mode: ScopeMode,
  ): Promise<CheckResult> {
    // 边界(E178):target 路径 type + 长度前置闸,与主 fs.ipc fsPath() 的 FS_PATH_MAX 对齐。所有
    // plugin-fs 读写操作(read/lstat/remove/rename/write/mkdir)都经本 chokepoint;此前直接进
    // resolveForX → fs.realpath,超长合法路径触发 ENAMETOOLONG / CPU·内存放大,非 string 还会变
    // TypeError(而非稳定 SCOPE_ERROR)。统一拦在 realpath 之前;错误不回显原始(可能超长)target。
    if (
      typeof target !== 'string' ||
      target.length === 0 ||
      target.length > FS_PATH_MAX
    ) {
      throw new ScopeError('invalid target path', { reason: 'target-invalid' });
    }
    const { pluginId } = this.identityRegistry.resolve(token, senderId);
    const scopes = this.pluginScopes.get(pluginId) ?? [];

    let resolved: CheckResult;
    if (opType === 'read') {
      const { canonical } = await resolveForRead(target);
      resolved = { canonical };
    } else if (
      opType === 'lstat' ||
      opType === 'remove' ||
      opType === 'rename-src'
    ) {
      // 不跟随 leaf 符号链接:作用在链接本身(rm 删链接 / lstat 看链接 / rename 移链接),
      // 而非 realpath 跟随到目标。父目录仍 realpath + leaf 经 validateLeaf,无 scope 逃逸。
      const r = await resolveNoFollowLeaf(target);
      const fullPath = `${r.parentCanonical}${sep}${r.leaf}`;
      resolved = { parentCanonical: r.parentCanonical, leaf: r.leaf, fullPath };
    } else if (opType === 'write' || opType === 'mkdir') {
      const r = await resolveForWrite(target);
      const fullPath = `${r.parentCanonical}${sep}${r.leaf}`;
      resolved = { parentCanonical: r.parentCanonical, leaf: r.leaf, fullPath };
    } else if (opType === 'rename-dst') {
      const r = await resolveForRenameDst(target);
      const fullPath = `${r.parentCanonical}${sep}${r.leaf}`;
      resolved = { parentCanonical: r.parentCanonical, leaf: r.leaf, fullPath };
    } else {
      throw new ScopeError(`unknown opType: ${opType as string}`, {
        target,
        reason: 'opType',
      });
    }

    const probe = 'fullPath' in resolved ? resolved.fullPath : resolved.canonical;
    const match = scopes.find((s) => {
      if (mode === 'rw' && s.mode !== 'rw') return false;
      return isWithinScope(s.path, probe);
    });
    if (!match) {
      throw new ScopeError('target not in any granted scope', {
        target: probe,
        reason: `mode=${mode}, scopes=${scopes.length}`,
      });
    }

    return resolved;
  }

  /** Union by path; if present, takes wider mode (rw > r). 写入内存并返回合并结果。 */
  private mergeScopes(
    pluginId: string,
    newScopes: readonly PathScope[],
  ): PathScope[] {
    const existing = this.pluginScopes.get(pluginId) ?? [];
    const byPath = new Map(existing.map((s) => [s.path, s]));
    // 边界(E81):其它 plugin 已占的全局计数(本 plugin 现有 = existing.length)。
    const otherTotal = this.totalScopes - existing.length;
    for (const ns of newScopes) {
      const prev = byPath.get(ns.path);
      if (prev) {
        // 已存在 path:仅放宽 mode(rw>r),不增计数,不受上限影响。
        if (ns.mode === 'rw' && prev.mode === 'r') {
          byPath.set(ns.path, { path: ns.path, mode: 'rw' });
        }
        continue;
      }
      // 新 path:per-plugin + 全局上限,超限 fail-closed 丢弃(不无界增长撑爆内存/元数据文件)。
      if (byPath.size >= MAX_SCOPES_PER_PLUGIN) continue;
      if (otherTotal + byPath.size >= MAX_SCOPES_GLOBAL) continue;
      byPath.set(ns.path, { path: ns.path, mode: ns.mode });
    }
    const merged = [...byPath.values()];
    this.totalScopes += merged.length - existing.length;
    this.pluginScopes.set(pluginId, merged);
    return merged;
  }

  /** Grant scopes for a plugin. Union by path; if present, takes wider mode (rw > r). Emits 'scope-updated'. */
  grant(pluginId: string, newScopes: readonly PathScope[]): void {
    const merged = this.mergeScopes(pluginId, newScopes);
    this.emit('scope-updated', {
      pluginId,
      scopes: merged,
    } satisfies ScopeUpdatedEvent);
  }

  /**
   * 冷启动水合:把上次会话已授(磁盘持久化)的 scope 回填进内存,使本会话首次
   * requestScope 能直接命中 covers() 而无需再次弹窗。
   *
   * - 幂等:每个 plugin 仅水合一次(由 hydrated 集合守卫),即便 persistedScopes 为空
   *   也标记已水合,避免 request-scope handler 每次都打盘。
   * - 静默:不 emit 'scope-updated' —— 这是历史授权的恢复而非新授权决策,
   *   也避免把恢复事件误当作新 grant 再次触发持久化。
   */
  hydrate(pluginId: string, persistedScopes: readonly PathScope[]): void {
    if (this.hydrated.has(pluginId)) return;
    this.hydrated.add(pluginId);
    if (persistedScopes.length > 0) {
      this.mergeScopes(pluginId, persistedScopes);
    }
  }

  /** 该 plugin 本会话是否已水合过(供 handler 决定是否打盘)。 */
  isHydrated(pluginId: string): boolean {
    return this.hydrated.has(pluginId);
  }

  /**
   * 请求的全部 scope 是否已被现有授权覆盖 —— 同路径,或位于某条已授 scope 子树内,
   * 且已授 mode 不窄于请求(rw 覆盖 r/rw;r 仅覆盖 r)。覆盖 → request-scope 可静默
   * grant,免去对同会话已授 / 已水合持久化授权的重复弹窗。
   *
   * 入参须为 canonical 路径(与内存存储同一空间);与 check() 的前缀匹配语义一致。
   */
  covers(pluginId: string, requested: readonly PathScope[]): boolean {
    const scopes = this.pluginScopes.get(pluginId) ?? [];
    if (scopes.length === 0) return false;
    return requested.every((req) =>
      scopes.some((s) => {
        if (req.mode === 'rw' && s.mode !== 'rw') return false;
        return isWithinScope(s.path, req.path);
      }),
    );
  }

  /** 当前已授 scope 快照(持久化用)。 */
  getScopes(pluginId: string): readonly PathScope[] {
    return this.pluginScopes.get(pluginId) ?? [];
  }

  /** Revoke ALL scopes for a plugin (on plugin unload). */
  revokeAll(pluginId: string): void {
    this.hydrated.delete(pluginId);
    const removed = this.pluginScopes.get(pluginId);
    if (this.pluginScopes.delete(pluginId)) {
      this.totalScopes -= removed?.length ?? 0; // 边界(E81):同步全局计数,防泄漏
      this.emit('scope-updated', {
        pluginId,
        scopes: [],
      } satisfies ScopeUpdatedEvent);
    }
  }

  /** Test-only: inspect. */
  _peek(pluginId: string): readonly PathScope[] {
    return this.pluginScopes.get(pluginId) ?? [];
  }
}
