// fs:list-dir 选项的 zod schema + 类型单一来源(同 terminal-create.ts 的做法):main(fs.ipc)用 schema 校验,
// fs-channels 以 `import type` + z.infer 派生 FsListDirOptions 给 preload(类型导入被擦除,preload 不带 zod)。

import { z } from 'zod';
import { LIST_DIR_TOTAL_ENTRIES_MAX } from './fs-limits';

/** fs IPC 里单个名字(文件名 / exclude 项)的长度上限。 */
export const FS_IPC_NAME_MAX = 1024;
const FS_EXCLUDE_MAX = 1000;

export const ListDirOptionsSchema = z
  .object({
    maxDepth: z.number().int().positive().optional(),
    exclude: z.array(z.string().max(FS_IPC_NAME_MAX)).max(FS_EXCLUDE_MAX).readonly().optional(), // 边界(E21)
    // perf P2:文件数上限(深递归早停)。见 fs/list-dir.ts ListDirOptions.maxFiles。
    // 边界(E275):上界对齐到 list-dir 的条目硬上限 + 安全整数 —— 此前只 positive int,畸形 IPC 可传
    // 1e308(仍过 z.int())绕过调用方早停,迫使主进程遍历/排序/回传近 10 万条放大。超上限直接 BAD_INPUT。
    maxFiles: z.number().int().positive().max(LIST_DIR_TOTAL_ENTRIES_MAX).optional(),
    // 性能:false 时不 lstat、不回传 size/mtime/ctime(Quick Open 用)。见 ListDirOptions.withStats。
    withStats: z.boolean().optional(),
    // 递归扫描遵从 .gitignore / .ignore(Quick Open,VSCode search.useIgnoreFiles)。见 ListDirOptions.useIgnoreFiles。
    useIgnoreFiles: z.boolean().optional(),
  })
  .strict();
