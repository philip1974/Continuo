// 回归守卫:preload 在 Electron sandbox 运行,**无法 require('zod')**。preload 会把
// electron/shared/*-channels.ts 的 channel 常量当**值** import(非 type),若某个 channel
// 文件混入 `import { z } from 'zod'`(如放了 zod 入参 schema),bundler 会把整个模块连同
// zod 拖进 preload 产物 → 运行时 `Unable to load preload script: module not found: zod`,
// 整个 app 白屏(单测/typecheck 抓不到,只有真跑 Electron 才暴露)。
//
// 故:channel 常量文件必须 zod-free;zod 入参 schema 放到 main 侧 ipc/*.ipc.ts。
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
      // 只看真实代码行:剥掉 `//` 行注释(否则解释失败模式的注释文字会被误判),逐行
      // 找 `... from 'zod'` import 或 `require('zod')`。
      const offending = src.split(/\r?\n/).some((line) => {
        const code = line.replace(/\/\/.*$/, '');
        return (
          /\bfrom\s+['"]zod['"]/.test(code) ||
          /\brequire\(\s*['"]zod['"]\s*\)/.test(code)
        );
      });
      if (offending) offenders.push(`electron/shared/${f}`);
    }
    expect(offenders).toEqual([]);
  });
});
