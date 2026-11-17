// main 以 ESM 方式 `import { createServer } from 'node:http'` 时,Node 22(Electron 38 内置)会读取 node:http
// 的全部导出(含 WebSocket 等懒加载 getter),连带加载并编译整个 undici:冷启动 main 求值稳定多 17–18ms
//(约占 import 阶段 40%)。CJS require 不触发。mcp-host 只用 createServer → 经 createRequire 取。
import { readFileSync } from 'node:fs';
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
});
