// 终审 P1:js-debug adapter 不在 git 里(.gitignore),只有 CI 会执行 scripts/fetch-debug-adapter.mjs;
// 本地 `pnpm build:app*`(发布流程即在本地打包)不下载它,electron-builder 对缺失的 extraResources 只警告 →
// 干净检出产出的安装包调试功能完全不可用。打包前必须确保 adapter 已就位(缓存标记与版本 / sha256 / 树哈希全部吻合时跳过,无网络开销;否则删除重下)。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('打包前获取并校验 js-debug adapter', () => {
  it('build:pack 先执行 fetch-debug-adapter(所有 build:app* 都经由 build:pack)', () => {
    const pack = pkg.scripts['build:pack'] ?? '';
    expect(pack).toMatch(/node scripts\/fetch-debug-adapter\.mjs\s*&&/);
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      if (name.startsWith('build:app')) expect(cmd).toContain('pnpm build:pack');
    }
  });
});
