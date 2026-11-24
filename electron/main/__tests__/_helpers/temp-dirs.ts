// 按用例收集临时目录,afterEach 统一删除(electron 侧版本;electron/ 下测试不能从 src/ 导入,
// 同 API 见 src/__tests__/_helpers/tmp-dir.ts)。vitest 的 after 钩子按注册逆序执行:想让删除在同级
// 其它 afterEach 之后跑,就在那个 afterEach 之前调用。默认不 realpath。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

export function setupTempDirs(): { make(prefix: string): Promise<string> } {
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
  };
}
