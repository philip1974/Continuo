import { dialog, shell } from 'electron';
import { z } from 'zod';
import { defaultIsTrustedFrame, safeHandle } from '../safe-handle';
import { FS_CHANNELS } from '../../shared/fs-channels';
import { listDir } from './fs/list-dir';
import { readFile } from './fs/read-file';
import { atomicWriteFile } from './fs/atomic-write';
import { renameEntry } from './fs/rename';
import { removeEntry } from './fs/remove';
import { createDir, createFile } from './fs/create';

// ────────────────────────────────────────────────────────────
// schemas — 全部 .strict() 拒绝未知字段(防 IPC 注入)
// ────────────────────────────────────────────────────────────

const ListDirOptionsSchema = z
  .object({
    maxDepth: z.number().int().positive().optional(),
    exclude: z.array(z.string()).optional(),
    followSymlinks: z.boolean().optional(),
  })
  .strict();

export const listDirInputSchema = z
  .object({
    path: z.string().min(1),
    options: ListDirOptionsSchema.optional(),
  })
  .strict();

export const readFileInputSchema = z.object({ path: z.string().min(1) }).strict();

export const writeFileInputSchema = z
  .object({ path: z.string().min(1), content: z.string() })
  .strict();

export const renameInputSchema = z
  .object({ path: z.string().min(1), newName: z.string().min(1) })
  .strict();

export const removeInputSchema = z.object({ path: z.string().min(1) }).strict();

export const createFileInputSchema = z
  .object({ dir: z.string().min(1), name: z.string().min(1) })
  .strict();

export const createDirInputSchema = z
  .object({ parent: z.string().min(1), name: z.string().min(1) })
  .strict();

export const trashInputSchema = z.object({ path: z.string().min(1) }).strict();

// select-directory 显式严格:接受 undefined,拒绝 {} 与其它值
export const selectDirectoryInputSchema = z.undefined();

// 类型导出(给 preload / renderer 用)
export type ListDirInput = z.infer<typeof listDirInputSchema>;
export type ReadFileInput = z.infer<typeof readFileInputSchema>;
export type WriteFileInput = z.infer<typeof writeFileInputSchema>;
export type RenameInput = z.infer<typeof renameInputSchema>;
export type RemoveInput = z.infer<typeof removeInputSchema>;
export type CreateFileInput = z.infer<typeof createFileInputSchema>;
export type CreateDirInput = z.infer<typeof createDirInputSchema>;
export type TrashInput = z.infer<typeof trashInputSchema>;

// ────────────────────────────────────────────────────────────
// handlers — 浅函数,把 schema parse 后的对象映射给 fs 函数
// ────────────────────────────────────────────────────────────

export const listDirHandler = (input: ListDirInput) => listDir(input.path, input.options);
export const readFileHandler = (input: ReadFileInput) => readFile(input.path);
export const writeFileHandler = (input: WriteFileInput) => atomicWriteFile(input.path, input.content);
export const renameHandler = (input: RenameInput) => renameEntry(input.path, input.newName);
export const removeHandler = (input: RemoveInput) => removeEntry(input.path);
export const createFileHandler = (input: CreateFileInput) => createFile(input.dir, input.name);
export const createDirHandler = (input: CreateDirInput) => createDir(input.parent, input.name);

// trash / selectDirectory:工厂注入 deps,真 Electron API 留 E2E

export interface TrashDeps {
  trashItem: (path: string) => Promise<void>;
}
export const makeTrashHandler =
  (deps: TrashDeps) => async (input: TrashInput): Promise<void> => {
    await deps.trashItem(input.path);
  };

export interface SelectDirectoryDeps {
  showOpenDialog: (opts: {
    properties: ReadonlyArray<string>;
  }) => Promise<{ canceled: boolean; filePaths: ReadonlyArray<string> }>;
}
export const makeSelectDirectoryHandler =
  (deps: SelectDirectoryDeps) => async (): Promise<string | null> => {
    const r = await deps.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0] ?? null;
  };

// ────────────────────────────────────────────────────────────
// registerFsIpc — 拼装 9 条通道,真接 Electron API
// ────────────────────────────────────────────────────────────

export function registerFsIpc(): void {
  const trusted = defaultIsTrustedFrame;

  safeHandle(FS_CHANNELS.LIST_DIR, listDirInputSchema, listDirHandler, trusted);
  safeHandle(FS_CHANNELS.READ_FILE, readFileInputSchema, readFileHandler, trusted);
  safeHandle(FS_CHANNELS.WRITE_FILE, writeFileInputSchema, writeFileHandler, trusted);
  safeHandle(FS_CHANNELS.RENAME, renameInputSchema, renameHandler, trusted);
  safeHandle(FS_CHANNELS.REMOVE, removeInputSchema, removeHandler, trusted);
  safeHandle(FS_CHANNELS.CREATE_FILE, createFileInputSchema, createFileHandler, trusted);
  safeHandle(FS_CHANNELS.CREATE_DIR, createDirInputSchema, createDirHandler, trusted);

  safeHandle(
    FS_CHANNELS.TRASH,
    trashInputSchema,
    makeTrashHandler({
      // shell.trashItem 在 Electron 38 是 Promise<void>
      trashItem: (p) => shell.trashItem(p),
    }),
    trusted,
  );

  safeHandle(
    FS_CHANNELS.SELECT_DIRECTORY,
    selectDirectoryInputSchema,
    makeSelectDirectoryHandler({
      showOpenDialog: (opts) =>
        // adapter 抽象用 ReadonlyArray<string>,Electron 真 API 要窄字面量 enum,
        // 真接处补 type assertion。spec 已断言 properties 含 'openDirectory'。
        dialog.showOpenDialog({
          properties: opts.properties as Electron.OpenDialogOptions['properties'],
        }),
    }),
    trusted,
  );
}
