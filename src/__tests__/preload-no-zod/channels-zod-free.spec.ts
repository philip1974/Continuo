// 回归守卫:preload 在 Electron sandbox 运行,**无法 require('zod')**。preload 会把
// electron/shared/*-channels.ts 的 channel 常量当**值** import(非 type),若某个 channel
// 文件混入 `import { z } from 'zod'`(如放了 zod 入参 schema),bundler 会把整个模块连同
// zod 拖进 preload 产物 → 运行时 `Unable to load preload script: module not found: zod`,
// 整个 app 白屏(单测/typecheck 抓不到,只有真跑 Electron 才暴露)。
//
// 故:channel 常量文件不得值导入 zod;zod 入参 schema 放到 shared 的独立 *-schema.ts(main 值导入),channel 文件
// 只能 `import type`(编译时擦除,不进 preload 产物)从中推出类型 —— 同 terminal-create.ts 的做法。
// (本守卫源于 S4 marketplace-channels.ts 误把 fetchReviewsInputSchema 放 channels 文件
//  导致的 preload zod 泄漏。)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SHARED_DIR = join(process.cwd(), 'electron/shared');

describe('preload sandbox:shared channel 文件不得 import zod', () => {
  it('electron/shared/*-channels.ts 全部 zod-free(否则拖垮 sandbox preload)', () => {
    const channelFiles = readdirSync(SHARED_DIR).filter((f) =>
      f.endsWith('-channels.ts'),
    );
    expect(channelFiles.length).toBeGreaterThan(0); // sanity:确实扫到了文件

    const offenders: string[] = [];
    for (const f of channelFiles) {
      const src = readFileSync(join(SHARED_DIR, f), 'utf-8');
      // 只看真实代码:剥掉 `//` 行注释(否则解释失败模式的注释文字会被误判),按 import 语句判断:
      // `import type ... from 'zod'` 被擦除、放行;其它 `import ... from 'zod'` 与 `require('zod')` 都算泄漏。
      const code = src
        .split(/\r?\n/)
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
      const offending =
        /\bimport\s+(?!type\b)[^;]*?\bfrom\s+['"]zod['"]/.test(code) ||
        /\brequire\(\s*['"]zod['"]\s*\)/.test(code);
      if (offending) offenders.push(`electron/shared/${f}`);
    }
    expect(offenders).toEqual([]);
  });

  it('守卫本身:值导入 zod 判为泄漏,import type 放行', () => {
    const leak = (code: string): boolean =>
      /\bimport\s+(?!type\b)[^;]*?\bfrom\s+['"]zod['"]/.test(code) ||
      /\brequire\(\s*['"]zod['"]\s*\)/.test(code);
    expect(leak("import { z } from 'zod';")).toBe(true);
    expect(leak("import {\n  z,\n} from 'zod';")).toBe(true);
    expect(leak("const z = require('zod');")).toBe(true);
    expect(leak("import type { z } from 'zod';")).toBe(false);
  });
});
