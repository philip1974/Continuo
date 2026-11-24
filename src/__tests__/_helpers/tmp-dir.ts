// 测试共享 helper:按用例收集临时目录,afterEach 统一删除。
// 在模块顶层或 describe 内调用;注册的 afterEach 与所在位置同级。
// vitest 的 after 钩子按注册的逆序执行:想让它在同级其它 afterEach 之后跑,就在那个 afterEach 之前调用。
// 默认不 realpath(macOS 的 tmpdir 在 /var → /private/var 链接下),需要真实路径的用例自行 realpath。
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

export interface TempDirs {
  /** `mkdtemp(join(tmpdir(), prefix))`,记录待删。 */
  make(prefix: string): Promise<string>;
  /** `mkdtempSync(join(tmpdir(), prefix))`,记录待删。 */
  makeSync(prefix: string): string;
}

export function setupTempDirs(): TempDirs {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });
  return {
    async make(prefix) {
      const d = await mkdtemp(join(tmpdir(), prefix));
      dirs.push(d);
      return d;
    },
    makeSync(prefix) {
      const d = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(d);
      return d;
    },
  };
}
