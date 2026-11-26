// E2E 模式(CONTINUO_E2E=1)下的「移到废纸篓」:把目标挪进 <userData>/e2e-trash,不碰用户真实的系统废纸篓
//(e2e 夹具文件此前会堆进 ~/.Trash)。非 E2E 原样走 shell.trashItem。
// 失败语义与 shell.trashItem 对齐:源不存在 → 抛原生 ENOENT,由 makeTrashHandler 的 lstat 探测映射成 FS_NOT_FOUND。
import { cp, mkdir, rename as fsRename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

type TrashItem = (p: string) => Promise<void>;

export function makeE2eTrashItem(
  trashDir: string,
  deps: { rename?: (src: string, dest: string) => Promise<void> } = {},
): TrashItem {
  const rename = deps.rename ?? fsRename;
  return async (p) => {
    await mkdir(trashDir, { recursive: true });
    // 加随机前缀:同名多次移入互不覆盖(真实废纸篓同样保留每一份)。
    const dest = path.join(trashDir, `${randomUUID()}-${path.basename(p)}`);
    try {
      await rename(p, dest);
    } catch (err) {
      if ((err as { code?: string }).code !== 'EXDEV') throw err;
      // 跨卷(工作区与 userData 不在同一卷):退回复制后删除源。
      await cp(p, dest, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
      await rm(p, { recursive: true, force: true });
    }
  };
}

export function selectTrashItem(
  env: Readonly<Record<string, string | undefined>>,
  // 惰性取 userData:非 E2E 不触碰 app.getPath(注册期也不依赖 app 就绪)。
  getUserDataDir: () => string,
  shellTrashItem: TrashItem,
): TrashItem {
  if (env['CONTINUO_E2E'] !== '1') return shellTrashItem;
  return (p) => makeE2eTrashItem(path.join(getUserDataDir(), 'e2e-trash'))(p);
}
