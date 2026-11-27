import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat, statfs } from 'node:fs/promises';
import { constants as fsConstants, type Stats, type StatsFs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fsError, mapNodeErrnoCode } from './path-utils';
import { ERROR_CODES } from '../../../shared/error-codes';
import { MAX_WRITE_BYTES } from '../../../shared/fs-limits';
import { runSerialPerKey } from '../../../shared/run-serial-per-key';
import type { FsFileStat } from '../../../shared/fs-channels';

/**
 * 编辑器保存 / 原子写文件(ADR-009,借鉴 Lokus atomic_write_file;覆盖已有文件改为原地写,同 VSCode)。
 *
 * atomicWriteFile(编辑器保存)按目标分两种写法:
 *   - **已有普通文件 → 原地写**(VSCode diskFileSystemProvider.doWriteFile 默认:open 已有文件写内容,只有
 *     显式要求 atomic 的写才走 tmp + rename,且 VSCode 对符号链接也不做 atomic)。tmp + rename 替换的是**目录项**:
 *     只读目录(555)里的可写文件存不了(rename 要目录写权限)、扩展属性 / Finder 标签 / ACL / 创建时间丢失、
 *     硬链接被拆开(inode 变)、属主变成保存者。原地写保持同一 inode,上述元数据全部不动。见 writeInPlace。
 *   - **新建 / 非普通文件 → tmp + rename**(下述流程,与 atomicReplaceFileNoFollow 共用)。新建本来就要目录写权限,
 *     也没有要保留的元数据;rename 保证不会留下半截新文件。
 *
 * tmp + rename 流程:
 *   1. 写同目录的固定 tmp(`.<base>.continuo.tmp`,`open('wx')`;残留的旧 tmp 先删再建)+ fsync(fd)
 *   2. rename tmp → path     ← POSIX/Windows(MOVEFILE_REPLACE_EXISTING)原子替换
 *
 * 失败回滚:
 *   - 步骤 1 失败:删 .tmp,原文件不动
 *   - 步骤 2 失败:rename 失败不会改动目标,原文件保持完好;删 .tmp 后抛错
 *
 * 设计说明(审计 P2):旧实现在 rename 之前先把原文件 rename 成 `${path}.backup`,
 * 在「原文件已挪走」与「tmp 尚未就位」之间留了一个**进程崩溃 → path 不存在**的数据
 * 丢失窗口(且无任何启动期 .backup 恢复逻辑)。`rename(tmp → path)` 本身就是原子替换:
 * 原文件直到 rename 成功的那一刻始终完好,rename 失败也不动原文件 → 预备份多余且有害,
 * 故移除。原地写同样不 rename 原文件(没有「path 不存在」的窗口)。
 *
 * 并发(P1-AL,第十四轮 + 第十八轮自审修订):固定 tmp 名在同一路径的并发写
 * (autosave 连发 / 手动 Cmd+S 与 autosave 重叠 / 多窗或插件同写一文件)下会互相
 * 截断成半截文件,或后到的 rename 撞 ENOENT 丢写报错。**第十四轮**曾改唯一 tmp 名修并发,
 * 但**第十八轮自审**发现唯一名的反向代价:crash 在 fsync→rename 窗口残留的 `.tmp` 带随机
 * 后缀、永不被后续写复用、无清扫 → 单调累积孤儿文件。改为 **per-path 串行化 + 固定 tmp 名**:
 * 既消除并发损坏(同路径写排队、各自完整 rename = 干净 last-writer-wins),又让 crash 残留的
 * 单个 tmp 在下次同路径写时被删除重建、自愈,不累积。原地写同样在 per-path 锁内执行。
 *
 * 不做:父目录 mkdir(VSCode 行为:save 到不存在的目录就该报错)
 *
 * content 为 string → utf-8 写;为 Uint8Array → 二进制写(Step 5d Dropzone 路径)
 *
 * 返回值(性能:编辑器保存回声识别,见 FsFileStat):写入内容对应的 { mtimeMs, size, ino };无法确认则 undefined。
 */

// per-path 写串行化链。同一 filePath 的写排队执行,避免共享固定 tmp 名被并发截断。
const writeChains = new Map<string, Promise<unknown>>();

function withPathLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  // 排空回收(链尾仍是自己则删条目)由共享 runSerialPerKey 负责。
  return runSerialPerKey(writeChains, filePath, fn);
}

/**
 * 若 filePath 的 leaf 是 symlink,解析到真实目标后再写。读取(fs.readFile)跟随
 * symlink 到 target,保存也必须写穿到 target —— 否则 `rename(tmp, filePath)` 会用普通
 * 文件**替换链接本身**:链接断成普通文件、target 未更新,用户编辑落在断链副本里
 * (读/写语义不对称,数据安全复查 P1)。与 plugin-fs 的 rm/lstat/rename「实体
 * 操作不跟随 symlink」相反:内容读/写应对称跟随到目标。
 * 非 symlink / 不存在(新建)/ 断链(realpath 失败)→ 用原路径正常创建或替换。
 */
export async function resolveSymlinkTarget(filePath: string): Promise<string> {
  // 数据安全:lstat/realpath 的错误必须**只对 ENOENT 回退**,其它(EACCES/EIO 等)抛出。
  // catch-all 会把「无法确认状态」当新建/断链 → 回退原路径后 rename 用普通文件替换 symlink
  // 本身(断链、读写不对称),重现已修过的损坏(P1,#11 的连带缺口)。
  let st;
  try {
    st = await lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return filePath; // 新建文件
    throw err; // 无法确认:不盲目当普通文件写(可能覆盖/断链)
  }
  if (!st.isSymbolicLink()) return filePath; // 普通文件
  try {
    return await realpath(filePath); // symlink → 写穿到 canonical target
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return filePath; // 断链:替换链接(既有语义)
    throw err; // 无法确认目标:不 fail-open 断链
  }
}

export interface AtomicWriteFileOptions {
  /**
   * 目标是写保护文件(FS_READONLY)时仍覆盖:先去掉写保护(加属主写位,Windows 即清只读属性)再写,写完**不恢复**
   *(同 VSCode 保存遇写保护后用户选「覆盖」的 unlock 语义)。只有编辑器保存在用户确认后才传;插件 / 拖入 / CLI 配置写不提供。
   */
  readonly overwriteReadonly?: boolean;
}

export async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteFileOptions = {},
): Promise<FsFileStat | undefined> {
  // symlink → 写穿到 canonical target,并以 target 作锁 key(经不同 symlink 指向同一
  // target 的并发写也能正确串行)。
  const realPath = await resolveSymlinkTarget(filePath);
  return withPathLock(realPath, () =>
    atomicWriteFileInner(realPath, content, options.overwriteReadonly === true, true),
  );
}

/**
 * 不跟随 leaf 符号链接的原子替换:`rename(tmp, filePath)` 替换的是路径本身(若此刻是链接,替换掉链接),
 * 绝不写穿到链接目标。供写**不可信目录**里的文件(如 install_stop_hook 写 agent 仓库内的 CLI 配置:仓库
 * 可预置 `.codex/config.toml -> ~/.ssh/config`)使用;调用方仍须先 lstat 拒绝链接,此处收口「检查 → 写入」
 * 之间被换成链接的 TOCTOU。用户编辑器保存仍走 atomicWriteFile(读写对称跟随链接)。
 */
export async function atomicReplaceFileNoFollow(
  filePath: string,
  content: string | Uint8Array,
): Promise<FsFileStat | undefined> {
  // 写保护文件一律拒绝(FS_READONLY),不提供覆盖:插件 / 拖入 / CLI 配置写不应替用户去掉写保护。
  // 始终 tmp + rename(不原地写):原地 open 会跟随此刻被换成链接的路径写穿到链接目标,与本函数的不跟随语义相反。
  return withPathLock(filePath, () => atomicWriteFileInner(filePath, content, false, false));
}

/**
 * 数据安全(独立审计):tmp 由 `open('wx')` 以 0666&umask 新建,rename 覆盖后原文件的 POSIX 权限位被
 * 重置(`chmod 755 run.sh` 保存后丢执行位,0600 私密文件变 0644)。覆盖已有普通文件时返回其
 * `mode & 0o777` 供 tmp 继承 —— 同 VSCode / 多数编辑器只保留 rwx 位,不传播 setuid/setgid/sticky
 *(编辑后的内容不应继承特权位)。新建(ENOENT)/ 非普通文件(含符号链接本身)/ Windows(mode 仅映射只读位,语义有限)
 * → undefined,行为不变。其它 stat 错误抛出:无法确认原权限时不静默放宽(如 0600 → 0644)。
 *
 * 写保护(数据安全,第十一轮审计):tmp + rename 替换的是目录项,目录可写即可绕过文件自身的写保护 ——
 * 外部 `chmod 444` 的文件被静默改写。覆盖前检查:原文件无任何写位(Windows 只读属性即映射为此)或对当前用户
 * 不可写(access W_OK 拒绝)→ 抛 FS_READONLY,不写。overwriteReadonly(仅编辑器保存经用户确认)→ 同 VSCode
 * 先加属主写位(chmod,Windows 清只读属性;非属主则 EPERM → FS_DENIED)再写,新文件继承解锁后的权限。
 */
async function existingFileMode(
  filePath: string,
  overwriteReadonly: boolean,
): Promise<{ readonly mode: number } | undefined> {
  let st: Stats;
  try {
    // lstat 不跟随链接:atomicReplaceFileNoFollow 替换的是链接本身,新文件不得继承(探测)链接目标的权限位,
    // 链接按非普通文件处理(默认 mode)。atomicWriteFile 传入的已是 realpath,两者等价。
    st = await lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw fsError(mapNodeErrnoCode(err), `atomic write stat failed: ${filePath}`);
  }
  if (!st.isFile()) return undefined;
  let mode = st.mode & 0o777;
  if (await isWriteProtected(filePath, mode)) {
    if (!overwriteReadonly) {
      throw fsError(ERROR_CODES.FS_READONLY, `file is write-protected: ${filePath}`);
    }
    mode |= 0o200;
    try {
      await chmod(filePath, mode);
    } catch (err) {
      throw fsError(mapNodeErrnoCode(err), `atomic write unlock failed: ${filePath}`);
    }
  }
  return { mode };
}

/** 无任何写位(含 Windows 只读属性),或当前用户无写权限(access W_OK 被拒;root 恒通过,由前一条兜住 0444)。 */
async function isWriteProtected(filePath: string, mode: number): Promise<boolean> {
  if ((mode & 0o222) === 0) return true;
  try {
    await access(filePath, fsConstants.W_OK);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EACCES' || code === 'EPERM';
  }
}

async function atomicWriteFileInner(
  filePath: string,
  content: string | Uint8Array,
  overwriteReadonly: boolean,
  inPlace: boolean,
): Promise<FsFileStat | undefined> {
  const existing = await existingFileMode(filePath, overwriteReadonly);
  if (inPlace && existing !== undefined) {
    const r = await writeInPlace(filePath, content);
    if (r !== FALLBACK_TO_RENAME) return r;
  }
  return replaceViaTmp(filePath, content, existing);
}

async function replaceViaTmp(
  filePath: string,
  content: string | Uint8Array,
  existing: { readonly mode: number } | undefined,
): Promise<FsFileStat | undefined> {
  // tmp 用**隐藏标记名** `.<base>.continuo.tmp`(而非旧的可预测 `${filePath}.tmp`):
  // 旧名会与用户真实文件(如 `foo.md.tmp` —— 常见后缀)撞名,`open('w')` 直接截断它、
  // 随后 rename 连内容带文件一起销毁 → 数据丢失(P1)。隐藏 + 应用标记的 sibling
  // 实务上不可能是用户文件。仍是固定名(per-path 串行 + crash 残留自愈,见上方注释)。
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.continuo.tmp`);
  const keepMode = process.platform === 'win32' ? undefined : existing?.mode;

  // ① 写 tmp + fsync。open 'wx' 排他:绝不盲目截断已存在文件。EEXIST 只可能是本应用上次
  // crash(open→rename 窗口被杀)残留的同名标记 tmp(用户不会创建此名)→ 安全删除后重试
  // 一次,保留「固定名 crash 残留自愈」语义(第十八轮设计),同时不再有截断用户文件之虞。
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  // 本进程写的那份 tmp 的身份(dev/ino,关闭前经 fd 取,不受平台关闭时刷新 mtime 影响)。
  let handleId: Stats | undefined;
  try {
    try {
      fd = await open(tmpPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      await rm(tmpPath, { force: true }).catch(() => {});
      fd = await open(tmpPath, 'wx'); // 重试;再 EEXIST(跨进程竞态)则抛
    }
    // 覆盖已有文件:tmp 继承原权限位(fchmod 不受 umask 影响),否则 rename 后 0755 脚本丢执行位、
    // 0600 私密文件被放宽成 0644。
    if (keepMode !== undefined) await fd.chmod(keepMode);
    if (typeof content === 'string') {
      await fd.writeFile(content, 'utf-8');
    } else {
      await fd.writeFile(content);
    }
    await fd.sync();
    handleId = await fd.stat().catch(() => undefined);
  } catch (err) {
    await fd?.close().catch(() => {});
    await rm(tmpPath, { force: true }).catch(() => {});
    throw fsError(mapNodeErrnoCode(err), `atomic write tmp failed: ${filePath}`);
  } finally {
    await fd?.close().catch(() => {});
  }

  // 本次写入内容的身份:**写句柄关闭后**、rename 前对 tmp 取(失败不影响写盘本身)。不能在关闭前经 fd 取:
  // NTFS/FAT 在写句柄关闭时才刷新 LastWriteTime(GetFileTime 文档),关闭前的 mtime 与 rename 后目标
  // 几乎必然不一致 → Windows 上回声识别恒失效。NTFS rename 保留 FileId(ino)与 LastWriteTime。
  // close→stat 窗口:tmp 为隐藏标记名,同路径写已 per-path 串行,外部不会写它;即便有,rename 后的
  // 比对也只会在「目标 == 被 stat 的那份 tmp」时通过,其余不一致一律退化为整文件读。
  // 关闭后按路径 stat 须仍是本进程写的同一 inode:另一进程(如 dev 版与打包版同开)在关闭→stat 之间删掉
  // 并重建同名 tmp 时,不得把对方的内容记成自己的回声。
  // 只比 dev/ino 不够:Linux(ext4 等)删除后新建的文件常立即复用刚释放的 inode 号,被替换的 tmp 与本进程写的
  // 那份 dev/ino 完全相同。故同时核对 size == 本次写入字节数、birthtime 与关闭前经 fd 取的一致(新建文件的
  // 创建时间必然更晚;不支持 birthtime 的文件系统两侧同为 0,退化为 dev/ino/size)。不比 mtime/ctime:
  // NTFS 关闭写句柄时会刷新它们(见上)。
  const expectedSize = typeof content === 'string' ? Buffer.byteLength(content, 'utf-8') : content.byteLength;
  const tmpStat: Stats | undefined = await stat(tmpPath).catch(() => undefined);
  const written =
    tmpStat &&
    handleId &&
    tmpStat.dev === handleId.dev &&
    tmpStat.ino === handleId.ino &&
    tmpStat.size === expectedSize &&
    tmpStat.birthtimeMs === handleId.birthtimeMs
      ? tmpStat
      : undefined;

  // ② 原子 rename tmp → path(替换原文件)。失败不改动原文件,清 tmp 后抛。
  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw fsError(
      mapNodeErrnoCode(err),
      `atomic write rename failed: ${filePath}`,
    );
  }
  return confirmWrittenStat(filePath, written);
}

/**
 * rename 后对目标 stat 一次,与关闭写句柄后对 tmp 取得的「本次写入」身份(dev/ino/mtimeMs/size)比对:一致才返回
 * { mtimeMs, size, ino }。rename 与 stat 之间若有外部写入 / 替换,或平台在 rename 时改了 mtime,则
 * 不一致 → undefined(调用方不记录,外部同步照旧整文件读,绝不把别人的写入当成自己的回声)。
 */
async function confirmWrittenStat(
  filePath: string,
  written: Stats | undefined,
): Promise<FsFileStat | undefined> {
  if (!written) return undefined;
  const now = await stat(filePath).catch(() => undefined);
  if (
    !now ||
    now.dev !== written.dev ||
    now.ino !== written.ino ||
    now.mtimeMs !== written.mtimeMs ||
    now.size !== written.size
  ) {
    return undefined;
  }
  return { mtimeMs: now.mtimeMs, size: now.size, ino: now.ino };
}

/** writeInPlace 无法原地写(打不开读写,如只写权限的文件)→ 交回 tmp + rename(原文件未被改动)。 */
const FALLBACK_TO_RENAME = Symbol('fallback-to-rename');

type FileHandle = Awaited<ReturnType<typeof open>>;

/** 循环写满 [offset, offset+length)(FileHandle.write 可能只写一部分)。 */
async function writeFully(fh: FileHandle, data: Uint8Array, position: number, offset: number, length: number): Promise<void> {
  let done = 0;
  while (done < length) {
    const { bytesWritten } = await fh.write(data, offset + done, length - done, position + done);
    if (bytesWritten <= 0) throw Object.assign(new Error('short write'), { code: 'EIO' });
    done += bytesWritten;
  }
}

/** 读满 length 字节(文件在读期间被外部截短 → 抛,不拿不完整的备份去覆盖)。 */
async function readFully(fh: FileHandle, length: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, done);
    if (bytesRead <= 0) throw Object.assign(new Error('file shrank while saving'), { code: 'EIO' });
    done += bytesRead;
  }
  return buf;
}

/**
 * 原地写前要求的可用空间余量(字节):块取整与元数据开销。导出供测试按「刚好够 / 差一点」构造可用空间。
 */
export const IN_PLACE_SPACE_MARGIN = 1024 * 1024;

/** 原地写 newSize 字节前要求的可用空间:2 × 新内容字节数 + 余量(依据见 assertRoomToWriteInPlace)。 */
export function inPlaceSpaceNeeded(newSize: number): number {
  return 2 * newSize + IN_PLACE_SPACE_MARGIN;
}

/**
 * 原地写前的可用空间预检:可用空间(非特权用户可用,f_bavail × f_bsize)≥ inPlaceSpaceNeeded(新内容字节数)才原地写,
 * 不够 → FS_NO_SPACE,一个字节都不写。
 *
 * 为什么不只按「变长的部分」算:写时复制的文件系统(APFS 克隆文件 `cp -c` / Finder 复制、本地快照(Time Machine)
 * 仍引用的块、btrfs / ZFS / XFS reflink)上,覆盖**已有**的块也要分配新块,而且 ENOSPC 往往拖到 fsync / ftruncate
 * 才报 —— 此时回滚写回原内容同样要新空间,同样失败(实测:6 MB 克隆文件、卷剩 1.1 MB,删一行保存后原文件末尾 30 字节
 * 变 NUL;变长保存后原文件尾部接上新内容)。实测 APFS 改写克隆文件所需空间还明显多于文件大小(20 MB 卷:2 MB 文件
 * 约需 6.2 MB、6 MB 文件约需 10 MB;200 MB 卷 6 MB 文件约需 19 MB —— statfs 报的可用空间里含 APFS 不让用的保留量),
 * 故取 2 倍。无法可靠判断一个文件是否与别处共享块,一律按此预检。
 * 代价:普通(非写时复制)卷上可用空间小于「2 × 文件大小 + 1 MiB」时,本来能原地完成的保存也被拒绝(提示磁盘空间不足,原文件不变)。
 *
 * 这只是第一道闸,并不精确(APFS 保留量随容器大小变化;检查与写之间空间也可能被别的进程占掉):写失败的处理见
 * restoreOriginal。statfs 不可用 / 返回无意义的值(部分 FUSE / 网络卷报 0 块)→ 视为未知,照常原地写。
 */
async function assertRoomToWriteInPlace(filePath: string, newSize: number): Promise<void> {
  let s: StatsFs;
  try {
    s = await statfs(filePath);
  } catch {
    return;
  }
  if (!(s.blocks > 0) || !(s.bsize > 0) || !Number.isFinite(s.bavail)) return;
  const available = s.bavail * s.bsize;
  const needed = inPlaceSpaceNeeded(newSize);
  if (available < needed) {
    throw fsError(
      ERROR_CODES.FS_NO_SPACE,
      `not enough free space to save (need ${needed} bytes, ${available} available; file not modified): ${filePath}`,
    );
  }
}

let saveRecoveryDir: string | undefined;

/**
 * 原地写失败且无法还原原文件时,完整原内容副本写到的目录(主进程启动时设为 `<userData>/save-recovery`)。
 * 未设置(单测 / 早于注册)→ 只用系统临时目录下的 `continuo-save-recovery`。
 */
export function setSaveRecoveryDir(dir: string): void {
  saveRecoveryDir = dir;
}

/** 恢复副本的候选目录:配置的目录优先,系统临时目录兜底(两者常不在同一个卷上,一个满了另一个仍可写)。 */
function recoveryDirCandidates(): string[] {
  const fallback = join(tmpdir(), 'continuo-save-recovery');
  return saveRecoveryDir !== undefined && saveRecoveryDir !== fallback ? [saveRecoveryDir, fallback] : [fallback];
}

/** 每个文件最近一次写出的恢复副本路径:同样的原内容再次失败(自动保存反复重试)时复用,不在将满的磁盘上一份份堆副本。 */
const lastRecoveryCopy = new Map<string, string>();

/** 副本仍在且逐字节等于 original。 */
async function recoveryCopyMatches(copyPath: string, original: Uint8Array): Promise<boolean> {
  try {
    return (await readFile(copyPath)).equals(original);
  } catch {
    return false;
  }
}

/**
 * 把原内容完整写成一个新的恢复文件(0600,`wx` 排他新建,fsync),返回其路径;所有候选目录都写不成 → undefined。
 * 文件名:`<时间戳>-<原文件名(截断)>`,保留扩展名便于用户直接打开。同一文件上次的副本仍在且内容相同 → 直接返回它。
 */
async function writeRecoveryCopy(filePath: string, original: Uint8Array): Promise<string | undefined> {
  const previous = lastRecoveryCopy.get(filePath);
  if (previous !== undefined && (await recoveryCopyMatches(previous, original))) return previous;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = basename(filePath);
  const name = `${stamp}-${base.length > 100 ? base.slice(base.length - 100) : base}`;
  for (const dir of recoveryDirCandidates()) {
    const target = join(dir, name);
    let fh: FileHandle | undefined;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      fh = await open(target, 'wx', 0o600);
      await writeFully(fh, original, 0, 0, original.byteLength);
      await fh.sync();
      await fh.close();
      fh = undefined;
      lastRecoveryCopy.set(filePath, target);
      return target;
    } catch (err) {
      console.error('[fs] save in place: writing recovery copy failed', target, err);
      await fh?.close().catch(() => {});
      if (fh !== undefined) await rm(target, { force: true }).catch(() => {});
    }
  }
  return undefined;
}

/** 文件当前内容(经同一句柄读)是否与 expected 逐字节相同、长度相等。读不了 → false。 */
async function contentEquals(fh: FileHandle, expected: Uint8Array): Promise<boolean> {
  try {
    if ((await fh.stat()).size !== expected.byteLength) return false;
    return (await readFully(fh, expected.byteLength)).equals(expected);
  } catch {
    return false;
  }
}

/** writeInPlace 已经动过的范围(回滚只写回这些范围,不重写未动的字节 —— 写时复制卷上重写同样要新空间)。 */
interface TouchedRanges {
  /** 已开始覆盖 [0, overlap)。 */
  head: boolean;
  /** 已开始截短到新长度([新长度, 原长度) 可能已丢)。 */
  truncated: boolean;
}

/**
 * 原地写失败后的回滚:按 touched 把动过的范围用写前读出的**完整**原内容写回,截回原长度(去掉 ① 追加的尾部),fsync,
 * 再经句柄读回与原内容逐字节比对。
 *   - 写回、截断、fsync 都成功且读回一致 → 原文件已还原,抛原错误(按 errno 映射,如 FS_NO_SPACE)。
 *   - 任何一步失败或读回不一致(写时复制卷上回滚本身也要新空间,同样会 ENOSPC)→ 原文件可能已损坏:把完整原内容写成
 *     恢复副本(见 writeRecoveryCopy),抛 FS_SAVE_ORIGINAL_DAMAGED,details.recoveryPath = 副本路径(写不成则缺省)。
 *     绝不在这种情况下报普通的「保存失败」让用户以为原文件完好。
 */
async function restoreOriginal(
  fh: FileHandle,
  filePath: string,
  backup: Buffer,
  newSize: number,
  touched: TouchedRanges,
  cause: unknown,
): Promise<never> {
  const oldSize = backup.byteLength;
  let restored = false;
  try {
    if (touched.head) await writeFully(fh, backup, 0, 0, Math.min(oldSize, newSize));
    if (touched.truncated && newSize < oldSize) await writeFully(fh, backup, newSize, newSize, oldSize - newSize);
    await fh.truncate(oldSize);
    await fh.sync();
    restored = await contentEquals(fh, backup);
    if (!restored) console.error('[fs] save in place: restored content does not match the original', filePath);
  } catch (restoreErr) {
    console.error('[fs] save in place: restoring original failed', filePath, restoreErr);
  }
  if (restored) {
    throw fsError(mapNodeErrnoCode(cause), `save in place failed (original restored): ${filePath}`);
  }
  const recoveryPath = await writeRecoveryCopy(filePath, backup);
  const err = fsError(
    ERROR_CODES.FS_SAVE_ORIGINAL_DAMAGED,
    recoveryPath !== undefined
      ? `save failed and the original could not be restored; it may be damaged. A complete copy of the original was saved to ${recoveryPath}: ${filePath}`
      : `save failed and the original could not be restored; it may be damaged. Writing a recovery copy also failed: ${filePath}`,
  );
  throw Object.assign(err, recoveryPath !== undefined ? { details: { recoveryPath } } : {});
}

/**
 * 原地覆盖已有普通文件(同一 inode:目录权限、扩展属性 / Finder 标签、ACL、硬链接、属主、权限位、创建时间都不变)。
 *
 * VSCode 的原地写是 `open('w')` 先截断再写:写到一半失败(磁盘满)文件就只剩半截 / 空。这里的保证:**任何失败路径下,
 * 要么原文件逐字节不变,要么报 FS_SAVE_ORIGINAL_DAMAGED 并给出完整原内容的恢复副本路径**。步骤:
 *   0. 改动任何字节之前读出**完整**原内容 [0, 原长度) 作内存备份(原文件超过写入上限 → 交回 tmp + rename),
 *      并预检可用空间 ≥ 2 × 新内容字节数 + 余量(见 assertRoomToWriteInPlace;不够 → FS_NO_SPACE,不写)。
 *   ① 新内容比原文件长 → 先把超出原长度的尾部写到原文件末尾之后并 fdatasync,一次要到新增空间。
 *   ② 覆盖 [0, min(原长度, 新长度)) 并 fsync;③ 新内容更短 → 这之后才截到新长度并 fsync(覆盖失败时原文件长度与尾部都还在)。
 *   任一步失败 → restoreOriginal 回滚并逐字节核对,核对不过则写恢复副本。
 * 权衡:进程在 ②③ 中途被杀 / 断电会留下新旧混合的内容(VSCode 原地写同样;tmp + rename 没有此窗口但会丢上述元数据)。
 *
 * 打开用 O_RDWR | O_NOFOLLOW:调用方传入的已是 realpath,此刻若被换成符号链接(竞态)则拒绝(ELOOP),不写穿。
 * 打开得到的不是普通文件(竞态换成 FIFO / 目录)→ 不写,交回 tmp + rename(与新建 / 非普通文件同路径)。
 * 只写权限的文件(可写不可读,读不了备份)→ 同样交回 tmp + rename(原文件未改动,行为同旧实现)。
 */
async function writeInPlace(
  filePath: string,
  content: string | Uint8Array,
): Promise<FsFileStat | undefined | typeof FALLBACK_TO_RENAME> {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  const newSize = data.byteLength;
  let fh: FileHandle;
  try {
    fh = await open(filePath, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return FALLBACK_TO_RENAME;
    throw fsError(mapNodeErrnoCode(err), `save in place open failed: ${filePath}`);
  }
  let handleId: Stats | undefined;
  try {
    const before = await fh.stat();
    if (!before.isFile()) return FALLBACK_TO_RENAME;
    const oldSize = before.size;
    // 完整备份放不进内存上限(编辑器打不开这么大的文件,只可能是外部把它换大了)→ tmp + rename:原文件到 rename 成功前不动。
    if (oldSize > MAX_WRITE_BYTES) return FALLBACK_TO_RENAME;
    const overlap = Math.min(oldSize, newSize);
    // 备份在改动任何字节之前读:读失败 → 原文件未动,直接抛。
    let backup: Buffer;
    try {
      backup = await readFully(fh, oldSize);
    } catch (err) {
      throw fsError(mapNodeErrnoCode(err), `save in place read failed: ${filePath}`);
    }
    await assertRoomToWriteInPlace(filePath, newSize);
    const touched: TouchedRanges = { head: false, truncated: false };
    try {
      // ① 先占新增空间。
      if (newSize > oldSize) {
        await writeFully(fh, data, oldSize, oldSize, newSize - oldSize);
        await fh.datasync();
      }
      // ② 覆盖重叠段 + fsync。
      touched.head = true;
      await writeFully(fh, data, 0, 0, overlap);
      await fh.sync();
      // ③ 覆盖已落盘后才截短。
      if (newSize < oldSize) {
        touched.truncated = true;
        await fh.truncate(newSize);
        await fh.sync();
      }
    } catch (err) {
      await restoreOriginal(fh, filePath, backup, newSize, touched, err);
    }
    handleId = await fh.stat().catch(() => undefined);
  } finally {
    await fh.close().catch(() => {});
  }
  return confirmInPlaceStat(filePath, handleId, newSize);
}

/**
 * 原地写后的回声身份:关闭写句柄后按路径 stat,须与关闭前经句柄取的 dev/ino/mtimeMs 一致且 size == 写入字节数,
 * 才返回 { mtimeMs, size, ino }。关闭与 stat 之间被外部改写 / 替换 → 不一致 → undefined(调用方照旧整文件读,
 * 绝不把别人的写入当成自己的回声)。NTFS/FAT 在关闭写句柄时才刷新 LastWriteTime → Windows 上通常不一致,
 * 回声识别退化为整文件读(只损失一次读,不影响正确性);这里宁可保守,不放宽 mtime 比对。
 */
async function confirmInPlaceStat(
  filePath: string,
  handleId: Stats | undefined,
  expectedSize: number,
): Promise<FsFileStat | undefined> {
  if (!handleId) return undefined;
  const now = await stat(filePath).catch(() => undefined);
  if (
    !now ||
    now.dev !== handleId.dev ||
    now.ino !== handleId.ino ||
    now.mtimeMs !== handleId.mtimeMs ||
    now.size !== expectedSize ||
    handleId.size !== expectedSize
  ) {
    return undefined;
  }
  return { mtimeMs: now.mtimeMs, size: now.size, ino: now.ino };
}
