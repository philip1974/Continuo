// main 以 ESM 方式 `import { createServer } from 'node:http'` 时,Node 22(Electron 38 内置)会读取 node:http
// 的全部导出(含 WebSocket 等懒加载 getter),连带加载并编译整个 undici:冷启动 main 求值稳定多 17–18ms
//(约占 import 阶段 40%)。CJS require 不触发。mcp-host 只用 createServer → 经 createRequire 取。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('main 冷启动:node:http 不以 ESM 值导入', () => {
  it('electron/main 源码中 node:http 只允许 type import,值经 createRequire 取得', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../../electron/main/services/mcp-host.service.ts'),
      'utf8',
    );
    // 允许 `import type {...} from 'node:http'`,禁止值导入
    const valueImports = [...src.matchAll(/import\s+(?!type\b)[^;]*from\s+'node:http'/g)];
    expect(valueImports).toHaveLength(0);
    expect(src).toMatch(/createRequire\(import\.meta\.url\)\(\s*'node:http',?\s*\)/);
  });

  // 源码改 createRequire 不够:被打包进 main 的 sibling server-node transports/http.ts 自己值导入 node:http,
  // 其 createServer 被摇掉后,若外部内置模块被视为有副作用,Rollup 会留下裸 `import "node:http"` —— 裸导入
  // 同样会读取全部导出并加载 undici(实测)。内置模块无副作用 → 未被使用即整句删除。
  it('main 构建把外部 node: 内置模块视为无副作用(未用到即不留裸导入)', async () => {
    const { mainModuleSideEffects } = await import('../../../scripts/main-bundle-side-effects');
    expect(mainModuleSideEffects('node:http', true)).toBe(false);
    expect(mainModuleSideEffects('node:string_decoder', true)).toBe(false);
    // 非外部的本地模块仍按原规则(默认有副作用)
    expect(mainModuleSideEffects('/repo/electron/main/index.ts', false)).toBe(true);
  });

  const outMain = path.resolve(__dirname, '../../../out/main/index.js');
  it.skipIf(!existsSync(outMain))('产物 out/main/index.js 不含 node:http 的静态导入', () => {
    const out = readFileSync(outMain, 'utf8');
    expect(out).not.toMatch(/^import\s[^;]*["']node:http["'];?$/m);
  });
});
