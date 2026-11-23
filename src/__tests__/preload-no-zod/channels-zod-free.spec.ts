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

// 泄漏判定(按语句):
// - `import type { … } from …` / `import type * as … from …` 编译时整句擦除 → 放行;
// - 其它 `import` / `export … from 'zod'`(含 `import type from 'zod'` 这种把 type 当默认导入名的写法)、
//   `import 'zod'`、`require('zod')` → 泄漏;
// - 对同目录 `*-schema.ts`(zod schema 的家)的值导入 / 再导出同样算:会把 zod 传递带进 preload。
const NOT_TYPE_ONLY = String.raw`(?!\s+type\s*[{*])`;
const FROM_ZOD = String.raw`\bfrom\s+['"]zod['"]`;
const FROM_SCHEMA = String.raw`\bfrom\s+['"]\./[\w-]+-schema['"]`;
function leaksZod(code: string): boolean {
  return (
    new RegExp(String.raw`(^|[;\n])\s*(import|export)\b${NOT_TYPE_ONLY}[^;]*?${FROM_ZOD}`).test(code) ||
    new RegExp(String.raw`(^|[;\n])\s*(import|export)\b${NOT_TYPE_ONLY}[^;]*?${FROM_SCHEMA}`).test(code) ||
    /(^|[;\n])\s*import\s+['"]zod['"]/.test(code) ||
    /\brequire\(\s*['"]zod['"]\s*\)/.test(code)
  );
}

describe('preload sandbox:shared channel 文件不得 import zod', () => {
  it('electron/shared/*-channels.ts 全部 zod-free(否则拖垮 sandbox preload)', () => {
    const channelFiles = readdirSync(SHARED_DIR).filter((f) =>
      f.endsWith('-channels.ts'),
    );
    expect(channelFiles.length).toBeGreaterThan(0); // sanity:确实扫到了文件

    const offenders: string[] = [];
    for (const f of channelFiles) {
      const src = readFileSync(join(SHARED_DIR, f), 'utf-8');
      // 只看真实代码:剥掉 `//` 行注释(否则解释失败模式的注释文字会被误判),按语句判断(见 leaksZod)。
      const code = src
        .split(/\r?\n/)
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
      const offending = leaksZod(code);
      if (offending) offenders.push(`electron/shared/${f}`);
    }
    expect(offenders).toEqual([]);
  });

  it('守卫本身:值导入 / 再导出 / 副作用导入 zod 与值导入 *-schema 判为泄漏,import type 放行', () => {
    for (const leak of [
      "import { z } from 'zod';",
      "import {\n  z,\n} from 'zod';",
      "export { z } from 'zod';",
      "export * from 'zod';",
      "import type from 'zod';",
      "import type, { z } from 'zod';",
      "import 'zod';",
      "const z = require('zod');",
      "import { ShellExecInputSchema } from './shell-exec-schema';",
      "export { ShellExecInputSchema } from './shell-exec-schema';",
    ]) {
      expect(leaksZod(leak), leak).toBe(true);
    }
    for (const ok of [
      "import type { z } from 'zod';",
      "import type * as zod from 'zod';",
      "import type { ShellExecInputSchema } from './shell-exec-schema';",
      "import { foo } from './fs-limits';",
    ]) {
      expect(leaksZod(ok), ok).toBe(false);
    }
  });
});
