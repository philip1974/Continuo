import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fsError, mapNodeErrnoCode } from './path-utils';

/**
 * 原子写文件(ADR-009,借鉴 Lokus atomic_write_file)。
 *
 * 流程:
 *   1. 写 ${path}.tmp + fsync(fd)
 *   2. rename ${path}.tmp → path     ← POSIX/Windows(MOVEFILE_REPLACE_EXISTING)原子替换
 *
 * 失败回滚:
 *   - 步骤 1 失败:删 .tmp,原文件不动
 *   - 步骤 2 失败:rename 失败不会改动目标,原文件保持完好;删 .tmp 后抛错
 *
 * 设计说明(审计 P2):旧实现在 rename 之前先把原文件 rename 成 `${path}.backup`,
 * 在「原文件已挪走」与「tmp 尚未就位」之间留了一个**进程崩溃 → path 不存在**的数据
 * 丢失窗口(且无任何启动期 .backup 恢复逻辑)。`rename(tmp → path)` 本身就是原子替换:
 * 原文件直到 rename 成功的那一刻始终完好,rename 失败也不动原文件 → 预备份多余且有害,
 * 故移除。
 *
 * 并发(P1-AL,第十四轮 + 第十八轮自审修订):固定 `${path}.tmp` 在同一路径的并发写
 * (autosave 连发 / 手动 Cmd+S 与 autosave 重叠 / 多窗或插件同写一文件)下会互相 `open('w')`
 * 截断成半截文件,或后到的 rename 撞 ENOENT 丢写报错。**第十四轮**曾改唯一 tmp 名修并发,
 * 但**第十八轮自审**发现唯一名的反向代价:crash 在 fsync→rename 窗口残留的 `.tmp` 带随机
 * 后缀、永不被后续写复用、无清扫 → 单调累积孤儿文件。改为 **per-path 串行化 + 固定 tmp 名**:
 * 既消除并发损坏(同路径写排队、各自完整 rename = 干净 last-writer-wins),又让 crash 残留的
 * 单个 `${path}.tmp` 在下次同路径写时被复用覆盖、自愈,不累积。
 *
 * 不做:父目录 mkdir(VSCode 行为:save 到不存在的目录就该报错)
 *
 * content 为 string → utf-8 写;为 Uint8Array → 二进制写(Step 5d Dropzone 路径)
 */

// per-path 写串行化链。同一 filePath 的写排队执行,避免共享固定 tmp 名被并发截断。
const writeChains = new Map<string, Promise<unknown>>();

function withPathLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(filePath) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(
    () => {},
    () => {},
  );
  writeChains.set(filePath, settled);
  // 链排空且仍是尾部 → 删条目,避免 writeChains 随写过的路径单调增长。
  void settled.then(() => {
    if (writeChains.get(filePath) === settled) writeChains.delete(filePath);
  });
  return run;
}

/**
 * 若 filePath 的 leaf 是 symlink,解析到真实目标后再写。读取(fs.readFile)跟随
 * symlink 到 target,保存也必须写穿到 target —— 否则 `rename(tmp, filePath)` 会用普通
 * 文件**替换链接本身**:链接断成普通文件、target 未更新,用户编辑落在断链副本里
 * (读/写语义不对称,codex 数据安全复查 P1)。与 plugin-fs 的 rm/lstat/rename「实体
 * 操作不跟随 symlink」相反:内容读/写应对称跟随到目标。
 * 非 symlink / 不存在(新建)/ 断链(realpath 失败)→ 用原路径正常创建或替换。
 */
async function resolveSymlinkTarget(filePath: string): Promise<string> {
  // 数据安全:lstat/realpath 的错误必须**只对 ENOENT 回退**,其它(EACCES/EIO 等)抛出。
  // catch-all 会把「无法确认状态」当新建/断链 → 回退原路径后 rename 用普通文件替换 symlink
  // 本身(断链、读写不对称),重现已修过的损坏(codex P1,#11 的连带缺口)。
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

export async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  // symlink → 写穿到 canonical target,并以 target 作锁 key(经不同 symlink 指向同一
  // target 的并发写也能正确串行)。
  const realPath = await resolveSymlinkTarget(filePath);
  return withPathLock(realPath, () => atomicWriteFileInner(realPath, content));
}

async function atomicWriteFileInner(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  // tmp 用**隐藏标记名** `.<base>.continuo.tmp`(而非旧的可预测 `${filePath}.tmp`):
  // 旧名会与用户真实文件(如 `foo.md.tmp` —— 常见后缀)撞名,`open('w')` 直接截断它、
  // 随后 rename 连内容带文件一起销毁 → 数据丢失(codex P1)。隐藏 + 应用标记的 sibling
  // 实务上不可能是用户文件。仍是固定名(per-path 串行 + crash 残留自愈,见上方注释)。
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.continuo.tmp`);

  // ① 写 tmp + fsync。open 'wx' 排他:绝不盲目截断已存在文件。EEXIST 只可能是本应用上次
  // crash(open→rename 窗口被杀)残留的同名标记 tmp(用户不会创建此名)→ 安全删除后重试
  // 一次,保留「固定名 crash 残留自愈」语义(第十八轮设计),同时不再有截断用户文件之虞。
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      fd = await open(tmpPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      await rm(tmpPath, { force: true }).catch(() => {});
      fd = await open(tmpPath, 'wx'); // 重试;再 EEXIST(跨进程竞态)则抛
    }
    if (typeof content === 'string') {
      await fd.writeFile(content, 'utf-8');
    } else {
      await fd.writeFile(content);
    }
    await fd.sync();
  } catch (err) {
    await fd?.close().catch(() => {});
    await rm(tmpPath, { force: true }).catch(() => {});
    throw fsError(mapNodeErrnoCode(err), `atomic write tmp failed: ${filePath}`);
  } finally {
    await fd?.close().catch(() => {});
  }

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
}
