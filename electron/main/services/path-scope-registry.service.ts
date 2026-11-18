import { EventEmitter } from 'node:events';
import { sep } from 'node:path';
import { IdentityRegistry } from './identity-registry.service';
import {
  lexicalAbsolutePath,
  resolveForRead,
  resolveForRenameDst,
  resolveForWrite,
  resolveNoFollowLeaf,
} from './path-resolve.helper';
import { ScopeError, type PathScope } from '../../shared/plugin-fs-contract';
import { FS_PATH_MAX } from '../../shared/fs-limits';
import { PERMISSION_RECORD_LIMITS } from '../../shared/permission-record-limits';

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

/**
 * 词法预判用的包含判定。macOS / Windows 默认文件系统大小写不敏感(realpath 会还原真实大小写,此前
 * `/Users/x/Proj` 访问 `/Users/x/proj` 的 scope 可用),这两个平台忽略大小写;只决定「要不要碰文件系统」,
 * 最终授权仍由 realpath 后的精确匹配决定。
 */
function isLexicallyWithin(root: string, probe: string): boolean {
  return process.platform === 'linux'
    ? isWithinScope(root, probe)
    : isWithinScope(root.toLowerCase(), probe.toLowerCase());
}

function modeAllows(scope: PathScope, mode: ScopeMode): boolean {
  return mode !== 'rw' || scope.mode === 'rw';
}

/** scope 外路径的唯一拒绝形态:词法预判与 realpath 后的匹配共用,不带解析结果(不泄露链接指向)。 */
function notInScope(target: string, mode: ScopeMode, scopeCount: number): ScopeError {
  return new ScopeError('target not in any granted scope', {
    target,
    reason: `mode=${mode}, scopes=${scopeCount}`,
  });
}

// 边界(E79 注册表数量上限族 / E81):单次 request-scope 已限 64 条(E31),但插件可多次请求不同
// 路径,经 mergeScopes 把 pluginScopes 与 _plugin-path-scopes.json 持续撑大;此后每次 check() 线性
// 扫描 scopes、covers() 是 requested×scopes、启动 hydrate/持久化都随授权数线性增长,畸形插件可放大
// 主进程 CPU/内存与元数据文件。grant/hydrate/mergeScopes 统一在唯一-path 合并处执行 per-plugin +
// 全局上限,超限 fail-closed(丢弃新增 path,不无界增长;已存在 path 放宽 mode 不增计数)。
const MAX_SCOPES_PER_PLUGIN = PERMISSION_RECORD_LIMITS.PATH_SCOPES_PER_PLUGIN_MAX; // 与持久化读/写端同值
const MAX_SCOPES_GLOBAL = 4096;

function withFullPath(r: { parentCanonical: string; leaf: string }): CheckResultWrite {
  return {
    parentCanonical: r.parentCanonical,
    leaf: r.leaf,
    fullPath: `${r.parentCanonical}${sep}${r.leaf}`,
  };
}

export class PathScopeRegistry extends EventEmitter {
  private readonly pluginScopes = new Map<string, PathScope[]>();
  // 边界(E81):全局唯一-path scope 累计数(O(1) 维护,避免每次 merge 遍历全表求和)。
  private totalScopes = 0;
  /**
   * 已从磁盘水合过的 plugin。防止每次 requestScope 都打盘;revokeAll 时清除,
   * 以便插件重注册(re-enable / HMR)后重新水合。
   */
  private readonly hydrated = new Set<string>();
  /**
   * 插件 requestScope 时用的原始写法(词法绝对形)→ 它当时归一化到的 canonical 路径。只用于 check 的词法预判:
   * scope 存的是 canonical 路径,插件却常用请求时的写法访问(macOS `/tmp/x`、经符号链接的 workspace 路径)。
   * 不持久化 —— 每个会话插件都要重新 requestScope(水合也在那里),届时重新登记。
   */
  private readonly requestedRoots = new Map<string, Map<string, string>>();

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
  // 重载:'read' 解析为 canonical(跟随链接);其余 opType 一律解析为 parent + leaf(CheckResultWrite)。
  // 调用方据 opType 直接拿到窄类型,不必再手写 `'fullPath' in r` 守卫。
  check(
    token: string,
    senderId: number,
    opType: 'read',
    target: string,
    mode: ScopeMode,
  ): Promise<CheckResultRead>;
  check(
    token: string,
    senderId: number,
    opType: Exclude<ScopeOpType, 'read'>,
    target: string,
    mode: ScopeMode,
  ): Promise<CheckResultWrite>;
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

    // 安全(存在性探测):此前先 realpath 再匹配 scope,scope 外路径的错误因目标存在与否 / 类型而不同
    //(target does not exist / not in any granted scope / realpath failed: EACCES / parent missing /
    // symlink leaf rejected)—— 只有 fs 权限、没拿到任何 scope 的插件即可探测全盘。先做词法预判:词法上不在
    // 任何已授 scope 内 → 不碰文件系统,统一拒绝;在 scope 内才走 realpath(此时的细节属于已授权范围)。
    const lexical = lexicalAbsolutePath(target);
    if (!this.isLexicallyInScope(pluginId, scopes, lexical, mode)) {
      // 细节只进主进程日志(插件拿到的错误不区分原因)。
      console.warn(
        `[path-scope] ${pluginId} ${opType} denied: lexically outside granted scopes (mode=${mode}): ${lexical}` +
          ' — scopes match their canonical path or the spelling passed to requestScope',
      );
      throw notInScope(target, mode, scopes.length);
    }

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
      resolved = withFullPath(await resolveNoFollowLeaf(target));
    } else if (opType === 'write' || opType === 'mkdir') {
      resolved = withFullPath(await resolveForWrite(target));
    } else if (opType === 'rename-dst') {
      resolved = withFullPath(await resolveForRenameDst(target));
    } else {
      throw new ScopeError(`unknown opType: ${opType as string}`, {
        target,
        reason: 'opType',
      });
    }

    const probe = 'fullPath' in resolved ? resolved.fullPath : resolved.canonical;
    let match: PathScope | null = null;
    for (const s of scopes) {
      if (!modeAllows(s, mode)) continue;
      if (isWithinScope(s.path, probe)) {
        match = s;
        break;
      }
    }
    if (!match) throw notInScope(target, mode, scopes.length);

    return resolved;
  }

  /** 词法绝对路径是否落在某条(mode 足够的)已授 scope 的 canonical 根、或其已登记的请求写法之下。 */
  private isLexicallyInScope(
    pluginId: string,
    scopes: readonly PathScope[],
    lexical: string,
    mode: ScopeMode,
  ): boolean {
    const granted = (probe: string, within: (root: string, p: string) => boolean): boolean =>
      scopes.some((s) => modeAllows(s, mode) && within(s.path, probe));
    if (granted(lexical, isLexicallyWithin)) return true;
    for (const [root, canonical] of this.requestedRoots.get(pluginId) ?? []) {
      // 别名只在它对应的 canonical 路径仍被 mode 足够的 scope 覆盖时有效。
      if (isLexicallyWithin(root, lexical) && granted(canonical, isWithinScope)) return true;
    }
    return false;
  }

  /**
   * 登记插件 requestScope 用的原始写法(见 requestedRoots)。仅在该请求已被授予(用户允许 / 被已有授权覆盖)
   * 后调用;`requested` 与 `canonical` 按下标对应。已被词法覆盖的写法不重复登记,数量有上限(超限不登记 →
   * 该写法按 scope 外拒绝,fail-closed)。
   */
  noteRequestedRoots(
    pluginId: string,
    requested: readonly PathScope[],
    canonical: readonly PathScope[],
  ): void {
    const scopes = this.pluginScopes.get(pluginId) ?? [];
    for (let i = 0; i < requested.length; i += 1) {
      const canonicalPath = canonical[i]?.path;
      if (canonicalPath === undefined) continue;
      // 纵深:canonical 必须已折叠(canonicalizeScopePath 保证)。带 `..` 分量的 canonical 是字符串前缀上的
      // 「scope 内」,折叠后的请求写法却可能宽到 `/` —— 绝不为它登记别名。
      if (canonicalPath.split(/[\\/]/).includes('..')) continue;
      let lexical: string;
      try {
        lexical = lexicalAbsolutePath(requested[i]!.path);
      } catch {
        continue; // `~user` 等无法展开的写法:本就匹配不上任何目标
      }
      if (this.isLexicallyInScope(pluginId, scopes, lexical, 'r')) {
        // 已覆盖;若是同一写法且指向变了(链接被重指后重新请求),更新到新的 canonical。
        const roots = this.requestedRoots.get(pluginId);
        if (roots?.has(lexical)) roots.set(lexical, canonicalPath);
        continue;
      }
      let roots = this.requestedRoots.get(pluginId);
      if (!roots) {
        roots = new Map();
        this.requestedRoots.set(pluginId, roots);
      }
      if (roots.size >= MAX_SCOPES_PER_PLUGIN) continue;
      roots.set(lexical, canonicalPath);
    }
  }

  /** Union by path; if present, takes wider mode (rw > r). 写入内存并返回合并结果。 */
  private mergeScopes(
    pluginId: string,
    newScopes: readonly PathScope[],
  ): PathScope[] {
    const existing = this.pluginScopes.get(pluginId) ?? [];
    const byPath = new Map<string, PathScope>();
    for (const s of existing) byPath.set(s.path, s);
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
    const merged = new Array<PathScope>(byPath.size);
    let mergedCount = 0;
    for (const scope of byPath.values()) {
      merged[mergedCount++] = scope;
    }
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
    for (const req of requested) {
      let covered = false;
      for (const scope of scopes) {
        if (req.mode === 'rw' && scope.mode !== 'rw') continue;
        if (isWithinScope(scope.path, req.path)) {
          covered = true;
          break;
        }
      }
      if (!covered) return false;
    }
    return true;
  }

  /** 当前已授 scope 快照(持久化用)。 */
  getScopes(pluginId: string): readonly PathScope[] {
    return this.pluginScopes.get(pluginId) ?? [];
  }

  /** Revoke ALL scopes for a plugin (on plugin unload). */
  revokeAll(pluginId: string): void {
    this.hydrated.delete(pluginId);
    this.requestedRoots.delete(pluginId);
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
