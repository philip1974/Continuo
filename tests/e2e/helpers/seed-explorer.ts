// 预置 userData/explorer.json(v1 单窗口格式),让 Continuo 启动时 hydrate 指定工作区。
// with-workspace fixture 与自管生命周期的用例共用;此前各文件各写一份同结构 JSON。
// 刻意构造畸形 / 未来版本 / 多窗口格式的用例仍自己写文件。
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ExplorerSeed {
  readonly root: string;
  /** 缺省 `[root]`。 */
  readonly recentRoots?: readonly string[];
  /** 缺省 `[root]`。 */
  readonly expandedPaths?: readonly string[];
  /** 缺省按名称升序。 */
  readonly sort?: { readonly by: 'name' | 'mtime'; readonly reverse: boolean };
}

export function seedExplorerJson(userDataDir: string, seed: ExplorerSeed): void {
  writeFileSync(
    path.join(userDataDir, 'explorer.json'),
    JSON.stringify({
      version: 1,
      workspace: { root: seed.root, recentRoots: seed.recentRoots ?? [seed.root] },
      explorer: {
        activePath: null,
        expandedPaths: seed.expandedPaths ?? [seed.root],
        sort: seed.sort ?? { by: 'name', reverse: false },
      },
      pinned: { paths: [] },
    }),
  );
}
