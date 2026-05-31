import { spawn } from 'node:child_process';
import { promises as fs, type Dirent } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { app, type IpcMain, type WebContents } from 'electron';
import { PLUGIN_FS_CHANNELS } from '../../shared/plugin-fs-channels';
import { IdentityRegistry } from './identity-registry.service';
import { PathScopeRegistry } from './path-scope-registry.service';
import { ScopeRequestCorrelator } from './scope-request-correlator';
import { ScopeError, type PathScope } from '../../../src/plugins/types';

export interface PluginFsDeps {
  identityRegistry: IdentityRegistry;
  pathScopeRegistry: PathScopeRegistry;
  correlator: ScopeRequestCorrelator;
  /** webContents getter for hosts that need to route scope request events. */
  webContentsForSender: (senderId: number) => WebContents | null;
}

const TRASH_TTL_MS = 24 * 60 * 60 * 1000;
const TRASH_PREFIX = '.trash-';

interface StatPayload {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

function statPayload(s: {
  size: number;
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): StatPayload {
  return {
    size: s.size,
    mtimeMs: s.mtimeMs,
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymlink: s.isSymbolicLink(),
  };
}

function canonicalPath(r: { canonical: string } | { fullPath: string }): string {
  return 'canonical' in r ? r.canonical : r.fullPath;
}

export function registerPluginFsHandlers(
  ipcMain: IpcMain,
  deps: PluginFsDeps,
): void {
  const { identityRegistry, pathScopeRegistry, correlator } = deps;

  ipcMain.handle('plugin-fs:_register-plugin', async (event, pluginId: string) =>
    identityRegistry.register(pluginId, event.sender.id),
  );

  ipcMain.handle('plugin-fs:_unregister-plugin', async (_event, token: string) => {
    identityRegistry.revoke(token);
  });

  ipcMain.handle(
    'plugin-fs:read-file',
    async (event, token: string, target: string) => {
      const r = await pathScopeRegistry.check(
        token,
        event.sender.id,
        'read',
        target,
        'r',
      );
      return fs.readFile(canonicalPath(r), 'utf-8');
    },
  );

  ipcMain.handle(
    'plugin-fs:write-file',
    async (event, token: string, target: string, content: string) => {
      const r = await pathScopeRegistry.check(
        token,
        event.sender.id,
        'write',
        target,
        'rw',
      );
      if (!('fullPath' in r)) throw new ScopeError('write resolution failed');
      await fs.writeFile(r.fullPath, content, 'utf-8');
    },
  );

  ipcMain.handle('plugin-fs:list-dir', async (event, token: string, target: string) => {
    const r = await pathScopeRegistry.check(
      token,
      event.sender.id,
      'read',
      target,
      'r',
    );
    const entries = await fs.readdir(canonicalPath(r), { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
      isSymlink: e.isSymbolicLink(),
    }));
  });

  ipcMain.handle('plugin-fs:stat', async (event, token: string, target: string) => {
    const r = await pathScopeRegistry.check(
      token,
      event.sender.id,
      'read',
      target,
      'r',
    );
    return statPayload(await fs.stat(canonicalPath(r)));
  });

  ipcMain.handle('plugin-fs:lstat', async (event, token: string, target: string) => {
    const r = await pathScopeRegistry.check(
      token,
      event.sender.id,
      'lstat',
      target,
      'r',
    );
    return statPayload(await fs.lstat(canonicalPath(r)));
  });

  ipcMain.handle(
    'plugin-fs:realpath',
    async (event, token: string, target: string) => {
      const r = await pathScopeRegistry.check(
        token,
        event.sender.id,
        'read',
        target,
        'r',
      );
      return canonicalPath(r);
    },
  );

  ipcMain.handle(
    'plugin-fs:mkdir',
    async (
      event,
      token: string,
      target: string,
      opts?: { recursive?: boolean },
    ) => {
      const r = await pathScopeRegistry.check(
        token,
        event.sender.id,
        'mkdir',
        target,
        'rw',
      );
      if (!('fullPath' in r)) throw new ScopeError('mkdir resolution failed');
      await fs.mkdir(r.fullPath, { recursive: opts?.recursive ?? false });
    },
  );

  ipcMain.handle(
    'plugin-fs:rename',
    async (event, token: string, src: string, dst: string) => {
      const rSrc = await pathScopeRegistry.check(
        token,
        event.sender.id,
        'read',
        src,
        'rw',
      );
      const rDst = await pathScopeRegistry.check(
        token,
        event.sender.id,
        'rename-dst',
        dst,
        'rw',
      );
      const srcPath = canonicalPath(rSrc);
      if (!('fullPath' in rDst)) throw new ScopeError('rename resolution failed');
      if (dirname(srcPath) !== rDst.parentCanonical) {
        throw new ScopeError('rename: same-parent enforced', { target: dst });
      }
      await fs.rename(srcPath, rDst.fullPath);
    },
  );

  ipcMain.handle(
    'plugin-fs:rm',
    async (
      event,
      token: string,
      target: string,
      opts?: { recursive?: boolean; force?: boolean },
    ) => {
      const r = await pathScopeRegistry.check(
        token,
        event.sender.id,
        'read',
        target,
        'rw',
      );
      await fs.rm(canonicalPath(r), {
        recursive: opts?.recursive ?? false,
        force: opts?.force ?? false,
      });
    },
  );

  ipcMain.handle(
    'plugin-fs:cp',
    async (
      event,
      token: string,
      src: string,
      dst: string,
      opts?: { recursive?: boolean },
    ) => {
      const rSrc = await pathScopeRegistry.check(
        token,
        event.sender.id,
        'read',
        src,
        'r',
      );
      const rDst = await pathScopeRegistry.check(
        token,
        event.sender.id,
        'write',
        dst,
        'rw',
      );
      if (!('fullPath' in rDst)) throw new ScopeError('copy resolution failed');
      await fs.cp(canonicalPath(rSrc), rDst.fullPath, {
        recursive: opts?.recursive ?? false,
      });
    },
  );

  ipcMain.handle(
    'plugin-fs:read-git-blob',
    async (event, token: string, repoDir: string, sha: string) => {
      const r = await pathScopeRegistry.check(
        token,
        event.sender.id,
        'read',
        repoDir,
        'r',
      );
      return new Promise<Uint8Array>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const child = spawn('git', ['cat-file', 'blob', sha], {
          cwd: canonicalPath(r),
        });
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('close', (code) => {
          if (code === 0) {
            resolve(new Uint8Array(Buffer.concat(chunks)));
            return;
          }
          reject(
            new ScopeError(`git cat-file failed (exit ${code}): ${stderr}`, {
              target: sha,
            }),
          );
        });
        child.on('error', reject);
      });
    },
  );

  ipcMain.handle(
    'plugin-fs:atomic-replace',
    async (
      event,
      token: string,
      staging: string,
      final: string,
      opts?: { overwrite?: boolean },
    ) => {
      const rStaging = await pathScopeRegistry.check(
        token,
        event.sender.id,
        'rename-dst',
        staging,
        'rw',
      );
      const rFinal = await pathScopeRegistry.check(
        token,
        event.sender.id,
        'rename-dst',
        final,
        'rw',
      );
      if (!('fullPath' in rStaging) || !('fullPath' in rFinal)) {
        throw new ScopeError('atomicReplace resolution failed', { target: final });
      }
      if (rStaging.parentCanonical !== rFinal.parentCanonical) {
        throw new ScopeError('atomicReplace: staging/final must share parent', {
          target: final,
        });
      }
      await sweepStaleTrashInDir(rFinal.parentCanonical);
      await atomicReplacePaths(rStaging.fullPath, rFinal.fullPath, final, opts);
    },
  );

  ipcMain.handle(PLUGIN_FS_CHANNELS.USER_HOME, async (event, token: string) => {
    identityRegistry.resolve(token, event.sender.id);
    return app.getPath('home');
  });

  ipcMain.handle(
    'plugin-fs:request-scope',
    async (event, token: string, scopes: readonly PathScope[]) => {
      const { pluginId } = identityRegistry.resolve(token, event.sender.id);
      const { requestId, promise } = correlator.createRequest(
        token,
        scopes,
        event.sender.id,
      );
      event.sender.send('plugin-fs:scope-request', {
        requestId,
        pluginId,
        scopes,
      });
      const decision = await promise;
      if (decision === 'grant') pathScopeRegistry.grant(pluginId, scopes);
      return decision;
    },
  );

  ipcMain.handle(
    'plugin-fs:scope-decision',
    async (
      event,
      requestId: string,
      decision: 'grant' | 'deny',
    ): Promise<void> => {
      correlator.resolve(requestId, decision, event.sender.id);
    },
  );

  void sweepStaleTrashAtStartup(pathScopeRegistry);
}

async function atomicReplacePaths(
  stagingPath: string,
  finalPath: string,
  finalTarget: string,
  opts?: { overwrite?: boolean },
): Promise<void> {
  let finalExists = false;
  try {
    await fs.access(finalPath);
    finalExists = true;
  } catch {
    // doesn't exist - fine
  }
  if (!finalExists) {
    try {
      await fs.rename(stagingPath, finalPath);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        throw new ScopeError('cross-device rename not allowed', {
          target: finalTarget,
        });
      }
      throw err;
    }
  }
  if (!opts?.overwrite) {
    throw new ScopeError('final exists, overwrite not requested', {
      target: finalTarget,
    });
  }

  const trashPath = `${finalPath}.trash-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  let renamed = false;
  for (let i = 0; i < 3 && !renamed; i++) {
    try {
      await fs.rename(finalPath, trashPath);
      renamed = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' || i === 2) throw err;
      await new Promise((resolve) =>
        setTimeout(resolve, [100, 300, 1000][i]),
      );
    }
  }

  try {
    await fs.rename(stagingPath, finalPath);
  } catch (err) {
    try {
      await fs.rename(trashPath, finalPath);
    } catch {
      // trash leaked; original error remains the meaningful failure
    }
    throw err;
  }
  try {
    await fs.rm(trashPath, { recursive: true, force: true });
  } catch {
    // best effort cleanup only
  }
}

/** Sweep .trash-* older than TRASH_TTL_MS in given dir. Best-effort. */
export async function sweepStaleTrashInDir(
  dir: string,
): Promise<{ swept: number; failed: number }> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { swept: 0, failed: 0 };
  }

  let swept = 0;
  let failed = 0;
  const cutoff = Date.now() - TRASH_TTL_MS;
  for (const entry of entries) {
    if (!entry.name.startsWith(TRASH_PREFIX)) continue;
    const full = join(dir, entry.name);
    try {
      const s = await fs.stat(full);
      if (s.mtimeMs < cutoff) {
        await fs.rm(full, { recursive: true, force: true });
        swept++;
      }
    } catch {
      failed++;
    }
  }
  return { swept, failed };
}

/** Iterate registered plugin scopes and sweep stale trash in each. */
export async function sweepStaleTrashAtStartup(
  _registry: PathScopeRegistry,
): Promise<void> {
  // PathScopeRegistry intentionally does not expose all pluginIds yet.
  // Startup sweeping is a v0.1 no-op; atomicReplace sweeps the active parent.
}

export const TRASH_TTL_MS_FOR_TEST = TRASH_TTL_MS;
export const TRASH_PREFIX_FOR_TEST = TRASH_PREFIX;
