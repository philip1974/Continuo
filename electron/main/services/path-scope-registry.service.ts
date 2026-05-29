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

  /** Grant scopes for a plugin. Union by path; if present, takes wider mode (rw > r). Emits 'scope-updated'. */
  grant(pluginId: string, newScopes: readonly PathScope[]): void {
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
    this.emit('scope-updated', {
      pluginId,
      scopes: merged,
    } satisfies ScopeUpdatedEvent);
  }

  /** Revoke ALL scopes for a plugin (on plugin unload). */
  revokeAll(pluginId: string): void {
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
