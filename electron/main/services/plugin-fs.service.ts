import { spawn } from 'node:child_process';
import { promises as fs, type Dirent } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { app, type IpcMain, type WebContents } from 'electron';
import { PLUGIN_FS_CHANNELS } from '../../shared/plugin-fs-channels';
import { IdentityRegistry } from './identity-registry.service';
import { PathScopeRegistry } from './path-scope-registry.service';
import { ScopeRequestCorrelator } from './scope-request-correlator';
import { ScopeError, type PathScope } from '../../../src/plugins/types';
import { canonicalizeScopePath } from './path-resolve.helper';
import { atomicWriteFile } from '../ipc/fs/atomic-write';

export interface PluginFsDeps {
  identityRegistry: IdentityRegistry;
  pathScopeRegistry: PathScopeRegistry;
  correlator: ScopeRequestCorrelator;
  /** webContents getter for hosts that need to route scope request events. */
  webContentsForSender: (senderId: number) => WebContents | null;
}

const TRASH_TTL_MS = 24 * 60 * 60 * 1000;
const TRASH_PREFIX = '.trash-';

// 审计 P2-B:git cat-file 子进程的超时与输出上限。旧实现无 timeout、stdout 无界,
// 超大 blob 或 git 卡死(如 cwd 在网络挂载)会让 Promise 永不 resolve + 内存持续增长。
const GIT_BLOB_TIMEOUT_MS = 30_000;
const GIT_BLOB_MAX_BYTES = 64 * 1024 * 1024; // 64 MB 上限,够大但防 OOM

/**
 * 读取单个 git blob(`git cat-file blob <sha>`),带超时与字节上限。
 * 超时 / 超限 / spawn 错误 → SIGKILL 子进程并 reject。可注入 opts 供测试用小值。
 */
export function readGitBlob(
  cwd: string,
  sha: string,
  opts?: { timeoutMs?: number; maxBytes?: number },
): Promise<Uint8Array> {
  const timeoutMs = opts?.timeoutMs ?? GIT_BLOB_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? GIT_BLOB_MAX_BYTES;
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const child = spawn('git', ['cat-file', 'blob', sha], { cwd });
    let stderr = '';
    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(err);
    };
    const timer = setTimeout(
      () =>
        fail(
          new ScopeError(`git cat-file timed out after ${timeoutMs}ms`, {
            target: sha,
          }),
        ),
      timeoutMs,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        fail(
          new ScopeError(`git blob exceeds ${maxBytes} bytes`, { target: sha }),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
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
    child.on('error', (err) => fail(err));
  });
}

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
    // 撤 path-scope 必须在 revoke 之前 lookup(revoke 进 drain 但 lookup 仍能查到;
    // 这里先取 pluginId/generation 再撤,语义更清晰)。与 identity token 撤销对称:
    // 否则插件卸载/禁用后授予的 scope 永久驻留,同 id 重装直接继承(审计 #2)。
    const info = identityRegistry.lookup(token);
    identityRegistry.revoke(token);
    // generation 守卫:仅当没有更新实例已注册(generation 仍是最新)时才撤,
    // 避免 HMR reload 先 register 新实例后再 unregister 旧 token 时,
    // 误删新实例已 grant 的 scope。
    if (
      info &&
      identityRegistry.currentGeneration(info.pluginId) === info.generation
    ) {
      pathScopeRegistry.revokeAll(info.pluginId);
    }
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
      // crash-safe 原子写:裸 fs.writeFile 默认以 'w' 打开先 truncate,写入中途
      // ENOSPC/崩溃/掉电/进程被杀会把用户文件留成空/半截且无法回滚。复用 Explorer
      // fs:write-file 同款 atomicWriteFile(写同目录 tmp + fsync + rename 原子替换 +
      // per-path 串行),与主仓既有 crash-safe 写入语义(Explorer/autosave/plugin-data
      // atomicWriteJson)对齐。(codex 复审 loop R4:plugin-fs 平行入口漏了原子写保护)
      await atomicWriteFile(r.fullPath, content);
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
      // 拒绝静默覆盖已存在目标:POSIX rename(2) 原子覆盖既有文件 → 不防御则插件在
      // 授权目录内把 a 改成已存在 b 的名字会永久丢失 b 的内容。镜像 Explorer
      // renameEntry(electron/main/ipc/fs/rename.ts)早有的 inode 比较守卫 —— 仅当目标
      // 存在且与源不是同一 inode 时拒,大小写改名到自身(同 inode)放行。显式覆盖走
      // atomicReplaceWithinScope({overwrite:true}),普通 rename 保持非覆盖语义。
      // (codex 复审 loop R2:plugin-fs 平行入口漏了 Explorer 的 FS_EEXIST 守卫)
      let dstStat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
      try {
        dstStat = await fs.lstat(rDst.fullPath);
      } catch {
        dstStat = null; // ENOENT:目标不存在,正常改名
      }
      if (dstStat) {
        let srcStat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
        try {
          srcStat = await fs.lstat(srcPath);
        } catch {
          srcStat = null;
        }
        const sameEntry =
          srcStat != null &&
          dstStat.ino === srcStat.ino &&
          dstStat.dev === srcStat.dev;
        if (!sameEntry) {
          throw new ScopeError('rename: destination already exists', {
            target: dst,
            reason: 'EEXIST',
          });
        }
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
      // 拒绝静默覆盖已存在目标:Node fs.cp 默认 force:true,目标存在即覆盖 → 插件普通
      // copy 会丢用户已有文件。与 R2 的 rename 守卫对称(普通 cp 保持非覆盖语义,显式
      // 覆盖走 atomicReplaceWithinScope({overwrite:true}))。(codex 复审 loop R3:cp 是
      // R2 rename 的兄弟方法,同族「防御未传播到平行入口」)
      let cpDstStat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
      try {
        cpDstStat = await fs.lstat(rDst.fullPath);
      } catch {
        cpDstStat = null; // ENOENT:目标不存在,正常复制
      }
      if (cpDstStat) {
        throw new ScopeError('copy: destination already exists', {
          target: dst,
          reason: 'EEXIST',
        });
      }
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
      return readGitBlob(canonicalPath(r), sha);
    },
  );

  // 只读 scope 探测:返回 boolean 而非抛错,供 editor.openFile 等"先校验再走
  // 受信通道"的场景用。ScopeError → false(路径不在已授 scope);identity 错误
  // (未知 token / 跨窗)仍 rethrow,保持 fail-loud。
  ipcMain.handle(
    PLUGIN_FS_CHANNELS.CHECK_PATH,
    async (event, token: string, target: string): Promise<boolean> => {
      try {
        await pathScopeRegistry.check(token, event.sender.id, 'read', target, 'r');
        return true;
      } catch (err) {
        if (err instanceof ScopeError) return false;
        throw err;
      }
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
      // 弹窗挂起期间插件可能被卸载/禁用(_unregister-plugin → revoke token,token
      // 进 5s drain;lookup/resolve 仍能查到所以无法区分)。落地 grant 前重校验 token
      // 仍 active,否则会复活已撤销插件的 path-scope,同 id 重装直接继承(绕过
      // _unregister-plugin 的 revokeAll 守卫,审计 #2 同源)。见第十三轮 P2-AJ。
      if (decision === 'grant' && identityRegistry.isActive(token)) {
        // 归一化 scope 路径到与 check 的 probe 同一空间(expandHome + realpath)。否则
        // `~/...`(文档承诺 host-side 展开)或含符号链接组件的根(如 macOS `/tmp`→
        // `/private/tmp`)授予后永不匹配 → 该 scope 静默死掉,插件所有 fs 操作误拒。
        const canonicalScopes: PathScope[] = await Promise.all(
          scopes.map(async (s) => ({
            path: await canonicalizeScopePath(s.path),
            mode: s.mode,
          })),
        );
        pathScopeRegistry.grant(pluginId, canonicalScopes);
      }
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

/**
 * 构造可被 sweepStaleTrashInDir 回收的 trash 兄弟路径。三条不变量:
 *   1. basename 以 TRASH_PREFIX 开头 —— sweep 按前缀匹配,旧实现用
 *      `${finalPath}.trash-...`(后缀形式 `foo.json.trash-...`)永远匹配不上,
 *      rename 回滚失败时泄漏的 trash 永久驻留(审计 49 follow-up)。
 *   2. 与 finalPath 同父目录 —— 原子 rename 要求同设备。
 *   3. 保留原 basename 便于排障。
 */
export function trashPathFor(finalPath: string, unique: string): string {
  return join(
    dirname(finalPath),
    `${TRASH_PREFIX}${basename(finalPath)}-${unique}`,
  );
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

  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const trashPath = trashPathFor(finalPath, unique);
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
