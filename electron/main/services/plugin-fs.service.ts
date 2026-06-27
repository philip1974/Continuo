import { spawn } from 'node:child_process';
import { promises as fs, type Dirent } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { app, type IpcMain, type WebContents } from 'electron';
import { PLUGIN_FS_CHANNELS } from '../../shared/plugin-fs-channels';
import { createByteCappedBuffer } from '../lib/byte-capped-buffer';
import { IdentityRegistry } from './identity-registry.service';
import { PathScopeRegistry } from './path-scope-registry.service';
import { ScopeRequestCorrelator } from './scope-request-correlator';
import {
  ScopeError,
  ScopeRequestTimeoutError,
  type PathScope,
} from '../../../src/plugins/types';
import { canonicalizeScopePath } from './path-resolve.helper';
import { atomicWriteFile } from '../ipc/fs/atomic-write';
import { readFile as readFileCapped } from '../ipc/fs/read-file';
import {
  MAX_WRITE_BYTES,
  MAX_SCOPE_REQUEST_COUNT,
  validateScopesShape,
  isValidGitBlobSha,
} from '../../shared/fs-limits';
import { utf8BytesExceed } from '../../shared/utf8-byte-length';
import { fsError } from '../ipc/fs/path-utils';
import { ERROR_CODES } from '../../shared/error-codes';
import { isSafePluginId } from './plugins.service';

export interface PluginFsDeps {
  identityRegistry: IdentityRegistry;
  pathScopeRegistry: PathScopeRegistry;
  correlator: ScopeRequestCorrelator;
  /** webContents getter for hosts that need to route scope request events. */
  webContentsForSender: (senderId: number) => WebContents | null;
  /**
   * 冷启动水合:返回该 plugin 上次会话持久化的 path scope(canonical)。
   * 未注入(如测试)→ 跳过水合,行为同改造前(每次都弹窗)。
   */
  loadPersistedScopes?: (pluginId: string) => Promise<readonly PathScope[]>;
  /** 持久化该 plugin 当前全部已授 scope,供下次启动水合。best-effort。 */
  persistScopes?: (
    pluginId: string,
    scopes: readonly PathScope[],
  ) => Promise<void>;
}

const TRASH_TTL_MS = 24 * 60 * 60 * 1000;
const TRASH_PREFIX = '.trash-';

// 边界(E30):plugin-fs:list-dir 单层目录条目数硬上限(滥用 backstop,防超大数组 + IPC 全量返回)。
// 导出供测试用(避免在测试里硬编码 magic number)。
export const MAX_LIST_DIR_ENTRIES = 100_000;

// 边界(E31/E239):plugin-fs:request-scope 的 scopes 是插件直传 IPC payload。数量/路径长度上限 + mode
// 枚举收口到 shared(fs-limits.validateScopesShape),main 与 renderer scoped-app 共用单一来源。此处
// re-export MAX_SCOPE_REQUEST_COUNT 维持既有测试 import 路径(实义在 shared)。
export { MAX_SCOPE_REQUEST_COUNT };
// 边界(E96):scope-decision 的 requestId 上限(correlator 用的是 UUID,~36 字符,256 留足余量)。
const MAX_REQUEST_ID_LEN = 256;
// 边界(E97):注册入口 pluginId 长度上限(对齐 manifest id 上限 E74 NAME_MAX)。
const MAX_PLUGIN_ID_LEN = 256;

// 审计 P2-B:git cat-file 子进程的超时与输出上限。旧实现无 timeout、stdout 无界,
// 超大 blob 或 git 卡死(如 cwd 在网络挂载)会让 Promise 永不 resolve + 内存持续增长。
const GIT_BLOB_TIMEOUT_MS = 30_000;
const GIT_BLOB_MAX_BYTES = 64 * 1024 * 1024; // 64 MB 上限,够大但防 OOM
// 边界(E63,E62 同款):cat-file stderr 累积上限(失败时拼进 ScopeError message)。
const GIT_BLOB_STDERR_MAX = 64 * 1024;
// 边界(E63 / E314):git blob sha hex 形态校验收口到 shared/fs-limits(renderer scoped-app readGitBlob
// 发 IPC 前同款预检,单一来源防漂移)。

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
    // 边界(E63 + E132,E131 同款):按真实 UTF-8 字节累积/截断 stderr,decode 延后整体进行。
    const stderrCap = createByteCappedBuffer(GIT_BLOB_STDERR_MAX);
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
    // 边界(E63 + E132):stderr 累积上限(按真实字节),超限停止追加(防超大错误输出膨胀 + 撑爆 message)。
    child.stderr.on('data', (chunk: Buffer) => stderrCap.push(chunk));
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(new Uint8Array(Buffer.concat(chunks)));
        return;
      }
      reject(
        new ScopeError(`git cat-file failed (exit ${code}): ${stderrCap.text()}`, {
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

  ipcMain.handle(
    'plugin-fs:_register-plugin',
    async (event, pluginId: unknown) => {
      // 边界(E97):pluginId 来自 renderer,裸 register 绕过 manifest id 正则 + E86/E87 持久化
      // canonicalize 前门。超长/非法 id 会经 request-scope/persist/broadcast 携带 → 主进程 Map
      // 长期驻留 + 路径 scope 持久化键污染 + IPC payload 放大。注册入口复用插件 id 规则
      //(isSafePluginId:^[a-z0-9._-]+$ 且非 . / ..)+ 长度上限;非法固定 BAD_INPUT,不进 registry。
      if (
        typeof pluginId !== 'string' ||
        pluginId.length > MAX_PLUGIN_ID_LEN ||
        !isSafePluginId(pluginId)
      ) {
        throw fsError(ERROR_CODES.BAD_INPUT, 'invalid pluginId');
      }
      return identityRegistry.register(pluginId, event.sender.id);
    },
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
      // 边界(E28,E18 平行入口):scope 校验后直接 fs.readFile(.., 'utf-8') 无大小上限,
      // 已授权插件可让主进程整块读入超大文件再经 IPC 回 renderer → 内存峰值/卡死。复用主
      // fs:read-file 的 readFile(E18:读前 stat.size,超 64MiB 抛 FS_FILE_TOO_LARGE +
      // 目录守卫 + errno 映射),单一来源,与 write-file 复用 atomicWriteFile(R4)同手法。
      return readFileCapped(canonicalPath(r));
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
      // 边界(E29,E13 平行入口):content 此前无大小上限直接进 atomicWriteFile。已授权插件可经
      // 单次 IPC 发超大字符串 → 主进程 IPC 内存峰值 + 超大临时文件 + fsync/rename 长时间阻塞。复用
      // 主 fs:write-file 的 MAX_WRITE_BYTES(64MiB,按 content.length 与主入口一致),进 atomicWriteFile
      // 前拒绝超限并抛 FS_FILE_TOO_LARGE(与 E28 读侧 twin 同错误码)。是 read-file E28 的写侧对偶。
      // 边界(E125):真实 UTF-8 字节(非 .length=UTF-16 code unit),与主 fs:write-file 同款。
      if (utf8BytesExceed(content, MAX_WRITE_BYTES)) {
        throw fsError(
          ERROR_CODES.FS_FILE_TOO_LARGE,
          `content 超过上限 ${MAX_WRITE_BYTES} 字节`,
        );
      }
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
    // 边界(E30,plugin-fs 平行入口):此前 fs.readdir 整目录后全量 map 返回,无条目数上限。
    // 已授权插件对超大目录调 listDir 会让主进程一次性构造巨大数组并经 IPC 全量返回 → 内存/CPU/
    // IPC 卡顿。用 opendir 惰性迭代(不先把全部 Dirent 物化进内存),累计到硬上限即 fail-closed
    // 抛 FS_DIR_TOO_LARGE(不静默截断 —— 截断会让插件误判「文件不存在」)。上限 100k 是滥用
    // backstop:单层目录 >10 万直接子项极罕见,远超任何现实插件目录。
    const out: {
      name: string;
      isFile: boolean;
      isDirectory: boolean;
      isSymlink: boolean;
    }[] = [];
    const dir = await fs.opendir(canonicalPath(r));
    for await (const e of dir) {
      if (out.length >= MAX_LIST_DIR_ENTRIES) {
        // for-await 在抛出时调用迭代器 return() 自动关闭 dir,无句柄泄漏。
        throw fsError(
          ERROR_CODES.FS_DIR_TOO_LARGE,
          `directory has too many entries (> ${MAX_LIST_DIR_ENTRIES})`,
        );
      }
      out.push({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
        isSymlink: e.isSymbolicLink(),
      });
    }
    return out;
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
      // 'rename-src' 走不跟随 leaf 解析:移动的是链接本身而非 realpath 跟随后的目标。
      const rSrc = await pathScopeRegistry.check(
        token,
        event.sender.id,
        'rename-src',
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
      } catch (err) {
        // 只有 ENOENT(不存在)才正常改名;EACCES/EIO 等「无法确认目标」不能 fail-open
        // (否则 rename 静默覆盖已有目标,codex P1 同族)→ 抛出中止。
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        dstStat = null;
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
      // 'remove' 走不跟随 leaf 解析:删的是链接本身而非 realpath 跟随后的目标数据。
      const r = await pathScopeRegistry.check(
        token,
        event.sender.id,
        'remove',
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
      } catch (err) {
        // 只有 ENOENT 才正常复制;其它 lstat 错误不 fail-open(同 rename 守卫,codex P1
        // 同族)。cp 自身已 force:false+errorOnExist 兜底,此处提前抛出更清晰一致。
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        cpDstStat = null; // ENOENT:目标不存在,正常复制
      }
      if (cpDstStat) {
        throw new ScopeError('copy: destination already exists', {
          target: dst,
          reason: 'EEXIST',
        });
      }
      // force:false + errorOnExist:true 关闭 lstat→cp 之间的 TOCTOU 窗口:fs.cp 默认
      // force:true 会击穿 errorOnExist(实测仅 force:false 时生效),目标若在 lstat 后被
      // 并发创建仍会静默覆盖。前置 lstat 保留只为更早给出友好的 ScopeError。
      try {
        await fs.cp(canonicalPath(rSrc), rDst.fullPath, {
          recursive: opts?.recursive ?? false,
          force: false,
          errorOnExist: true,
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_FS_CP_EEXIST') {
          throw new ScopeError('copy: destination already exists', {
            target: dst,
            reason: 'EEXIST',
          });
        }
        throw err;
      }
    },
  );

  ipcMain.handle(
    'plugin-fs:read-git-blob',
    async (event, token: string, repoDir: string, sha: string) => {
      // 边界(E63):sha 进 git cat-file argv 前先校验固定 hex 形态 + 长度(挡超长 sha 触发 spawn
      // E2BIG / argv 内存放大;非 hex 也直接拒,绝不进 spawn)。
      if (!isValidGitBlobSha(sha)) {
        throw new ScopeError('invalid git blob sha (must be 4-64 hex chars)', {
          target: typeof sha === 'string' ? sha.slice(0, 64) : 'non-string',
        });
      }
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

      // 边界(E31):scopes 是插件直传的 IPC payload,此前无运行时校验就批量 canonicalize
      // (realpath)+ 原样发 renderer 弹窗 + 可能进 registry/persist。畸形插件可传超大数组/
      // 超长路径/非法 mode → 主进程批量 realpath、大 IPC payload、弹窗渲染卡顿;非法 mode 还污染
      // 后续授权匹配语义。入口 fail-closed 校验数量/路径长度/mode 枚举,超限直接拒绝(不进
      // canonicalize/弹窗/持久化)。其余 IPC 入口校验同族:E11/E12/E16/E17/E23。
      // 边界(E31/E239):共享 helper 校验(数量 + 每项 path/mode),与 renderer scoped-app 同一来源。
      const scopesErr = validateScopesShape(scopes);
      if (scopesErr) {
        throw fsError(ERROR_CODES.BAD_INPUT, scopesErr);
      }

      // 归一化请求 scope 到与 registry 内存同一空间(expandHome + realpath),供覆盖
      // 判定与落地复用。否则 `~/...` 或含符号链接组件的根授予后永不匹配 → scope 静默
      // 死掉,插件所有 fs 操作误拒。canonicalizeScopePath 对不存在路径 fail-safe(回退
      // 展开值,不抛),故提前到弹窗前归一化是安全的。
      const canonicalScopes: PathScope[] = await Promise.all(
        scopes.map(async (s) => ({
          path: await canonicalizeScopePath(s.path),
          mode: s.mode,
        })),
      );

      // 冷启动水合:首次见到该 plugin 时,把上次会话已授 scope 从磁盘回填进 registry,
      // 使重启后对同一目录的 requestScope 直接命中 covers() 而不再弹窗。读盘失败也标记
      // 已水合,避免每个请求重复打盘。
      if (deps.loadPersistedScopes && !pathScopeRegistry.isHydrated(pluginId)) {
        try {
          const persisted = await deps.loadPersistedScopes(pluginId);
          pathScopeRegistry.hydrate(pluginId, persisted);
        } catch {
          pathScopeRegistry.hydrate(pluginId, []);
        }
      }

      // 已被现有授权(本会话 grant 或已水合的持久化授权)覆盖 → 静默授予,免重复弹窗。
      // 这是「持久化方案」省去重启后重复授权的关键路径。
      if (pathScopeRegistry.covers(pluginId, canonicalScopes)) {
        return 'grant';
      }

      // 边界(E227):未决 scope 请求数到顶(全局/单窗口)→ 终态 deny 收口,不入 pending、不向 renderer
      // 发弹窗。插件 spam request-scope 否则让主进程 pending Map / renderer 弹窗队列 / TTL 定时器线性增长。
      if (!correlator.canAccept(event.sender.id)) {
        return 'deny';
      }
      const { requestId, promise } = correlator.createRequest(
        token,
        scopes,
        event.sender.id,
      );
      // race(R73,agent-auth R62 同族):createRequest 登记 pending 后、send 前 sender 可能销毁
      // (renderer reload/关窗),send 抛 "Object has been destroyed"。下方 try 只裹 `await promise`,
      // 不裹这次 send;若 send 裸抛,该 pending 会泄漏到 5min TTL 才被 sweep —— 插件侧
      // requestScope() 一直挂着,且用户从未看到授权弹窗(发送失败),形成「授权请求假死」。send 包
      // try/catch:失败时立即 cancelBySender 清掉本 sender 的 pending(sender 已死),按终态 deny
      // 收口。promise.catch 吞掉 cancel 触发的 reject,避免 unhandled rejection(此处不再 await 它)。
      try {
        event.sender.send('plugin-fs:scope-request', {
          requestId,
          pluginId,
          scopes,
        });
      } catch {
        promise.catch(() => undefined);
        correlator.cancelBySender(event.sender.id);
        return 'deny';
      }
      let decision: 'grant' | 'deny';
      try {
        decision = await promise;
      } catch (err) {
        // 窗口硬关闭会经 cancelScopeRequestsForWebContents → correlator.cancelBySender
        // reject 该 pending(ScopeRequestTimeoutError 'window closed')。此时等待的
        // renderer 已随窗口销毁,reply 无处可送;若任由 reject 冒泡,Electron 会记成
        // "Error occurred in handler for 'plugin-fs:request-scope'" 噪声。sender 已销毁
        // → 视为终态 deny 静默收口(不 grant)。renderer 仍存活的 TTL 超时仍按原契约
        // reject,让 renderer 的 requestScope() 抛出。
        if (err instanceof ScopeRequestTimeoutError && event.sender.isDestroyed()) {
          return 'deny';
        }
        throw err;
      }
      // 弹窗挂起期间插件可能被卸载/禁用(_unregister-plugin → revoke token,token
      // 进 5s drain;lookup/resolve 仍能查到所以无法区分)。落地 grant 前重校验 token
      // 仍 active,否则会复活已撤销插件的 path-scope,同 id 重装直接继承(绕过
      // _unregister-plugin 的 revokeAll 守卫,审计 #2 同源)。见第十三轮 P2-AJ。
      if (decision === 'grant' && identityRegistry.isActive(token)) {
        pathScopeRegistry.grant(pluginId, canonicalScopes);
        // 持久化合并后的全集,供下次启动水合;best-effort,失败不影响本次授权。
        if (deps.persistScopes) {
          try {
            await deps.persistScopes(
              pluginId,
              pathScopeRegistry.getScopes(pluginId),
            );
          } catch {
            // ignore persist failure: 本会话已 grant,仅下次重启会回退到弹窗。
          }
        }
      }
      return decision;
    },
  );

  ipcMain.handle(
    'plugin-fs:scope-decision',
    async (event, requestId: unknown, decision: unknown): Promise<void> => {
      // 边界(E96):requestId/decision 来自 renderer,裸 handle 无 schema 校验。超长 requestId 会被
      // 塞进 ScopeRequestTimeoutError 经 IPC reject/log/toast 链路放大;非法 decision 命中 pending
      // 会 resolve 成非预期值,破坏授权决策契约。入口 fail-closed:requestId 非空且 ≤ 上限、decision
      // 须 enum;非法抛 BAD_INPUT(固定文案,不把原始 requestId 拼进错误)。
      if (
        typeof requestId !== 'string' ||
        requestId.length === 0 ||
        requestId.length > MAX_REQUEST_ID_LEN
      ) {
        throw fsError(ERROR_CODES.BAD_INPUT, 'invalid scope-decision requestId');
      }
      if (decision !== 'grant' && decision !== 'deny') {
        throw fsError(ERROR_CODES.BAD_INPUT, 'invalid scope-decision value');
      }
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
  } catch (err) {
    // 只有 ENOENT 才是「不存在」。EACCES/EIO/ELOOP 等「无法确认目标状态」不能 fail-open
    // (否则走无覆盖分支 rename 仍可能替换实际存在的 final,绕过 overwrite:false 契约 —
    // 与 rename/move/cp fail-closed 守卫一致,codex P1)。抛出中止 replace。
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
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
