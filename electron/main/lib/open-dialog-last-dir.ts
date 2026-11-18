// Electron 43 起 dialog.showOpenDialog 未传 defaultPath 时固定从「下载」目录打开(此前由 OS 记住
// 上次浏览的位置)。这里在主进程记住上次选中项的父目录,作为下一次的 defaultPath,恢复原体验。
// 纯工厂,不 import electron;真实 dialog 由调用方注入(见 open-dialog.ts)。
import path from 'node:path';

interface OpenDialogOptionsLike {
  defaultPath?: string;
}
interface OpenDialogResultLike {
  canceled: boolean;
  filePaths: string[];
}

export function createRememberingOpenDialog<
  O extends OpenDialogOptionsLike,
  R extends OpenDialogResultLike,
>(show: (opts: O) => Promise<R>): (opts: O) => Promise<R> {
  let lastDir: string | undefined;
  return async (opts) => {
    const r = await show(
      lastDir === undefined || opts.defaultPath !== undefined ? opts : { ...opts, defaultPath: lastDir },
    );
    const first = r.filePaths[0];
    if (!r.canceled && first !== undefined) lastDir = path.dirname(first);
    return r;
  };
}
