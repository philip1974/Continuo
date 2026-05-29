import { randomBytes } from 'node:crypto';
import { PluginIdentityError } from '../../../src/plugins/types';

type EntryState = 'active' | 'draining';

interface RegistryEntry {
  pluginId: string;
  webContentsId: number;
  generation: number;
  state: EntryState;
  createdAt: number;
  drainStartedAt?: number;
}

export interface RegisterResult {
  token: string;
  generation: number;
}

const DRAIN_GRACE_MS = 5_000;

export class IdentityRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly generations = new Map<string, number>();
  private readonly drainTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** PluginManager calls on instance creation. Returns opaque token + monotonic generation. */
  register(pluginId: string, webContentsId: number): RegisterResult {
    const token = randomBytes(32).toString('hex');
    const generation = (this.generations.get(pluginId) ?? 0) + 1;
    this.generations.set(pluginId, generation);
    this.entries.set(token, {
      pluginId,
      webContentsId,
      generation,
      state: 'active',
      createdAt: Date.now(),
    });
    return { token, generation };
  }

  /**
   * Main IPC handler first line. Throws PluginIdentityError on:
   *   - token unknown
   *   - senderId !== entry.webContentsId (cross-window IPC)
   * In (b) topology all plugins share webContents, so senderId check catches
   * cross-window attacks only; per-plugin isolation comes from scoped-app closures.
   */
  resolve(token: string, senderId: number): { pluginId: string; generation: number } {
    const entry = this.entries.get(token);
    if (!entry) throw new PluginIdentityError('unknown token');
    if (entry.webContentsId !== senderId) {
      throw new PluginIdentityError('senderId mismatch');
    }
    if (entry.state === 'draining') {
      console.warn(
        `[identity-registry] resolve on draining token plugin=${entry.pluginId} gen=${entry.generation}`,
      );
    }
    return { pluginId: entry.pluginId, generation: entry.generation };
  }

  /** PluginManager calls on plugin destroy / HMR reload. Token enters drain state; 5s later GC removes it. */
  revoke(token: string): void {
    const entry = this.entries.get(token);
    if (!entry || entry.state === 'draining') return;
    entry.state = 'draining';
    entry.drainStartedAt = Date.now();
    const timer = setTimeout(() => {
      this.entries.delete(token);
      this.drainTimers.delete(token);
    }, DRAIN_GRACE_MS);
    const maybeUnref = timer as { unref?: () => void };
    if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
    this.drainTimers.set(token, timer);
  }

  /** Test-only: synchronous GC (skip setTimeout). */
  _gcDrainedNow(): void {
    for (const [token, timer] of this.drainTimers) {
      clearTimeout(timer);
      this.entries.delete(token);
      this.drainTimers.delete(token);
    }
  }

  /** Test-only: inspect. */
  _peek(token: string): RegistryEntry | undefined {
    return this.entries.get(token);
  }
}

export const DRAIN_GRACE_MS_FOR_TEST = DRAIN_GRACE_MS;
