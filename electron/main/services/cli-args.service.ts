// CLI argv 文件夹路径拾取(issue #45)。
//
// Windows/Linux 拖文件夹到 app 图标冷启动时,路径会通过 process.argv 进入
// main process。这里把 argv 里的目录路径拉进与 macOS open-file 相同的
// dock-mode 缓冲池;等 packaging 加上 folder file-association 后即可生效。

import * as path from 'node:path';

export function pickArgvFolders(
  argv: readonly string[],
  isExistingDir: (p: string) => boolean,
  opts: { readonly skipFirstArg: boolean; readonly skipAll?: boolean },
): string[] {
  if (opts.skipAll) return [];

  const start = opts.skipFirstArg ? 2 : 1;
  const seen = new Set<string>();
  const dirs: string[] = [];

  for (const p of argv.slice(start)) {
    if (!path.isAbsolute(p)) continue;
    if (seen.has(p)) continue;
    if (!isExistingDir(p)) continue;
    seen.add(p);
    dirs.push(p);
  }

  return dirs;
}
