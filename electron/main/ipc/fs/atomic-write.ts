import { open, rename, rm } from 'node:fs/promises';
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

export function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  return withPathLock(filePath, () => atomicWriteFileInner(filePath, content));
}

async function atomicWriteFileInner(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const tmpPath = `${filePath}.tmp`;

  // ① 写 tmp + fsync
  let fd;
  try {
    fd = await open(tmpPath, 'w');
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
