import { EventEmitter } from 'node:events';
import { sep } from 'node:path';
import { IdentityRegistry } from './identity-registry.service';
import {
  resolveForRead,
  resolveForRenameDst,
  resolveForWrite,
} from './path-resolve.helper';
import { ScopeError, type PathScope } from '../../../src/plugins/types';

export type ScopeOpType = 'read' | 'write' | 'mkdir' | 'rename-dst' | 'lstat';
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

export class PathScopeRegistry extends EventEmitter {
  private readonly pluginScopes = new Map<string, PathScope[]>();
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
    const { pluginId } = this.identityRegistry.resolve(token, senderId);
    const scopes = this.pluginScopes.get(pluginId) ?? [];

    let resolved: CheckResult;
    if (opType === 'read' || opType === 'lstat') {
      const { canonical } = await resolveForRead(target);
      resolved = { canonical };
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
      return probe === s.path || probe.startsWith(s.path + sep);
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
    for (const ns of newScopes) {
      const prev = byPath.get(ns.path);
      if (!prev || (ns.mode === 'rw' && prev.mode === 'r')) {
        byPath.set(ns.path, { path: ns.path, mode: ns.mode });
      }
    }
    const merged = [...byPath.values()];
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
        return req.path === s.path || req.path.startsWith(s.path + sep);
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
    if (this.pluginScopes.delete(pluginId)) {
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
